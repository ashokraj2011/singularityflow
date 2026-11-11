import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { matrixMarkdown, matrixPage, matrixText } from '../src/evidence/matrix.mjs';
import { currentCompletenessReview, recordCompletenessReview, recordScopeDecision } from '../src/scope/decisions.mjs';
import { decisionListFacts } from '../src/decision-list-reads.mjs';

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
  // An attached document SFlow cannot read is not a decision of its own: uncited, it is background.
  const link = inventory.items.find((item) => item.id === 'DOC-002');
  assert.deepEqual([link.disposition, link.coveredBy, link.text], ['informative', 'attached-document', 'Design is attached (a link)']);
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
  assert.throws(() => decide({ disposition: 'included', clauseIds: ['W-1:AC-009'] }), (error) => error.code === 'SCOPE_CLAUSE_UNKNOWN'
    && /^W-1:AC-009 is not a clause of this Story's approved, submitted or open-draft specification; name clause IDs as it writes them, such as /u.test(error.message));
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

test('short or paraphrased scope uses exact substantive clause links, not substring guesses or token-only claims', async t => {
  const { root, directory } = await storyDirectory(t);
  const source = { acceptanceCriteria: ['test cases'] };
  const id = scopeItemId('story', 'test cases');
  const clause = { id: 'W-1:AC-001', body: 'Executable regression cases verify valid conversion and rejected inputs.' };
  const disposition = async (body, acceptedSource = source) => {
    const inventory = await buildScopeInventory(root, directory, workflow(), { source: acceptedSource, clauses: [{ ...clause, body }] });
    return inventory.items.find(entry => entry.sourceId === 'story');
  };
  assert.equal((await disposition(`${clause.body} covering test cases.`)).disposition, 'unresolved', 'short containment remains conservative');
  const linked = await disposition(`${clause.body} [scope:${id}]`);
  assert.equal(linked.disposition, 'included');
  assert.deepEqual(linked.clauseIds, [clause.id]);
  assert.equal(linked.decision, null, 'authored coverage never impersonates a human decision');
  for (const body of [`[scope:${id}]`, `${clause.body} [scope:SRI-000000000000]`, clause.body]) {
    assert.equal((await disposition(body)).disposition, 'unresolved', body);
  }
  assert.equal((await disposition(`${clause.body} [scope:${id}]`, { acceptanceCriteria: ['performance test cases'] })).disposition, 'unresolved',
    'a changed source needs its own exact reference');
  const otherSource = scopeItemId('DOC-001', 'test cases');
  assert.equal((await disposition(`${clause.body} [scope:${otherSource}]`)).disposition, 'unresolved', 'references are source-specific');
});

// ws-graph (2026-10-27): a screenshot kept on one laptop waited as an open decision nobody was asked,
// and refused the Story's last step although the specification cited it under AC-001.
test('an attached document a clause cites is included under it; a person\'s decision still wins', async t => {
  const { root, directory } = await storyDirectory(t);
  const source = { description: 'Plot a graph like the attached screenshot.' };
  const clauses = [{ id: 'W-1:AC-001', body: 'A screenshot shows the equation area and plotted circle guided by DOC-002.' },
    { id: 'W-1:REQ-001', body: 'The grid is labeled [scope:DOC-002].' }, { id: 'W-1:REQ-002', body: 'Not DOC-0020 or XDOC-002.' }];
  const story = workflow();
  const cited = (await buildScopeInventory(root, directory, story, { source, clauses })).items.find((item) => item.id === 'DOC-002');
  assert.deepEqual([cited.disposition, cited.clauseIds, cited.coveredBy], ['included', ['W-1:AC-001', 'W-1:REQ-001'], 'clause-citation']);
  const inventory = await buildScopeInventory(root, directory, story, { source, clauses });
  recordScopeDecision(story, { item: 'DOC-002', disposition: 'excluded', inventory, knownClauseIds: clauses.map((clause) => clause.id),
    reason: 'The reference design is out of scope for this Story.', actor: 'reviewer@example.invalid', authorityGroup: 'product-approvers', at: '2026-10-27T10:00:00Z' });
  const decided = (await buildScopeInventory(root, directory, story, { source, clauses })).items.find((item) => item.id === 'DOC-002');
  assert.deepEqual([decided.disposition, decided.coveredBy], ['excluded', undefined], 'the recorded decision, not the citation');
});

test('included human choices carry while source and linked clauses exist; removed links are not silently accepted', async t => {
  const { root, directory } = await storyDirectory(t);
  const source = { acceptanceCriteria: ['test cases'] };
  const clauses = [{ id: 'W-1:AC-001', body: 'Executable regressions verify supported and unsupported input.' }];
  const story = workflow();
  const inventory = await buildScopeInventory(root, directory, story, { source, clauses });
  const targets = [inventory.items.find(entry => entry.sourceId === 'story'), inventory.items.find(entry => entry.id === 'DOC-002')];
  for (const item of targets) recordScopeDecision(story, {
    item: item.id, disposition: 'included', clauseIds: [clauses[0].id], inventory,
    knownClauseIds: [clauses[0].id], reason: 'The reviewer confirms this clause carries the supplied scope.',
    actor: 'reviewer@example.invalid', authorityGroup: 'product-approvers', at: '2026-10-18T10:00:00Z'
  });
  const carried = await buildScopeInventory(root, directory, story, { source, clauses });
  const removed = await buildScopeInventory(root, directory, story, { source, clauses: [] });
  for (const target of targets) {
    assert.equal(carried.items.find(entry => entry.id === target.id).disposition, 'included');
    const missing = removed.items.find(entry => entry.id === target.id);
    assert.equal(missing.disposition, 'unresolved');
    assert.equal(missing.staleDecision, true);
    assert.deepEqual(missing.clauseIds, []);
  }
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

const ARTICLES = ['completeness', 'ambiguity', 'consistency', 'verifiability', 'boundary-conditions', 'non-functional'];

test('a completeness review answers every checklist article for exactly one structurally complete inventory', async (t) => {
  const { root, directory } = await storyDirectory(t);
  const story = workflow();
  const source = { description: 'The API must stay stable.' };
  const open = await buildScopeInventory(root, directory, story, { source, clauses: [] });
  const checklist = ARTICLES.map((article) => ({ article, decision: 'satisfied' }));
  const review = (inventory, overrides = {}) => recordCompletenessReview(story, {
    inventory, confirm: inventory.inventorySha256, checklist, reason: 'Read every source against the checklist; nothing is missing.',
    actor: 'po@example.test', authorityGroup: 'product-approvers', at: '2026-10-03T00:00:00.000Z', ...overrides
  });
  assert.throws(() => review(open), (error) => error.code === 'SCOPE_INVENTORY_INCOMPLETE', 'unresolved statements come first');

  const covered = await buildScopeInventory(root, directory, story, { source, clauses: [], scopeNotApplicable: true });
  assert.equal(covered.structurallyComplete, true);
  assert.throws(() => review(covered, { confirm: open.inventorySha256 }), (error) => error.code === 'SCOPE_INVENTORY_CHANGED');
  assert.throws(() => review(covered, { checklist: checklist.slice(1) }), (error) => error.code === 'SCOPE_CHECKLIST_INCOMPLETE', 'no article may be skipped');
  assert.throws(() => review(covered, { checklist: [...checklist, { article: 'vibes', decision: 'satisfied' }] }), (error) => error.code === 'SCOPE_CHECKLIST_INCOMPLETE');
  assert.throws(() => review(covered, { checklist: checklist.map((entry) => (entry.article === 'non-functional' ? { article: entry.article, decision: 'exception' } : entry)) }),
    (error) => error.code === 'SCOPE_CHECKLIST_INCOMPLETE', 'an exception needs its reason');
  assert.throws(() => review(covered, { reason: 'fine' }), (error) => error.code === 'SCOPE_REASON_REQUIRED');
  assert.equal(story.completenessReviews, undefined, 'a refusal records nothing');

  const recorded = review(covered, { checklist: checklist.map((entry) => (entry.article === 'non-functional'
    ? { article: entry.article, decision: 'not-applicable', reason: 'A wording change has no latency or privacy aspect.' } : entry)) });
  assert.deepEqual(recorded.checklist.decisions.map((entry) => entry.article), ARTICLES, 'decisions follow the checklist order');
  assert.equal(recorded.checklist.decisions.at(-1).reason, 'A wording change has no latency or privacy aspect.');
  assert.equal(currentCompletenessReview(story, covered), recorded);
  assert.equal(currentCompletenessReview(story, open), null, 'a review speaks only for the inventory it read');

  const evaluation = evaluateEvidence(evidenceGraph({ workflow: story, records: { indexes: [] }, scope: covered }));
  assert.deepEqual(
    [evaluation.summary.scope.structurallyComplete, evaluation.summary.scope.completenessReviewed, evaluation.summary.scope.correctness],
    [true, true, 'never-claimed']
  );
  assert.match(matrixMarkdown(evaluation), /- Scope: structurally complete \(\d+ statements?\); completeness reviewed by po@example\.test \(product-approvers\); correctness is never claimed/);
  assert.match(matrixText({ evaluation, page: matrixPage(evaluation) }), /Scope: structurally complete/);
  assert.doesNotMatch(matrixMarkdown(evaluation), /\bis correct\b|guarantee/i);

  // A changed disposition is a different inventory: the earlier review no longer speaks for it.
  const item = open.items.find((entry) => entry.text === 'The API must stay stable.');
  recordScopeDecision(story, {
    item: item.id, disposition: 'excluded', reason: 'Stability is owned by the platform team, not this Story.',
    actor: 'po@example.test', authorityGroup: 'product-approvers', at: '2026-10-03T01:00:00.000Z', inventory: open, knownClauseIds: []
  });
  const changed = await buildScopeInventory(root, directory, story, { source, clauses: [], scopeNotApplicable: true });
  assert.notEqual(changed.inventorySha256, covered.inventorySha256);
  const later = evaluateEvidence(evidenceGraph({ workflow: story, records: { indexes: [] }, scope: changed }));
  assert.deepEqual([later.summary.scope.completenessReviewed, later.summary.scope.words.review], [false, 'not reviewed for completeness']);
  assert.notEqual(later.inputSha256, evaluation.inputSha256);
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

  // The decision list offers the completeness review only while the step that defines the scope is current: a later
  // step opening the list for its own decision is not asked six scope questions. With no constitution pinned, the
  // consistency article asks only what it can [PHR:REQ-006].
  const definitionNow = YAML.parse(await readFile(file, 'utf8'));
  const stateNow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/SCOPE-1/workflow.json'), 'utf8'));
  const inScopeStep = await decisionListFacts(root, definitionNow, stateNow);
  assert.ok(inScopeStep.completeness, 'offered while the scope step is current');
  assert.equal(inScopeStep.completeness.articles.find((article) => article.id === 'consistency').question,
    'Do the requirements agree with each other and with the scenarios?');
  const laterStep = stateNow.phaseOrder[stateNow.phaseOrder.indexOf(stateNow.currentPhase) + 1];
  const later = await decisionListFacts(root, definitionNow, { ...stateNow, currentPhase: laterStep }, { phaseId: laterStep });
  assert.equal(later.completeness, null, `not offered at ${laterStep}`);

  // The completeness review [E2G-007] names the inventory it read and answers every article.
  const articles = ARTICLES.flatMap((article) => ['--article', `${article}=satisfied`]);
  const stale = run(process.execPath, [CLI, '--no-model', 'decision', 'completeness', '--confirm', shown.data.scope.inventorySha256, ...articles,
    '--reason', 'Every source read against the six checklist articles.', '--json'], root, { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /SCOPE_INVENTORY_CHANGED/);
  const offered = JSON.parse(sflow('evidence', 'scope', '--json').stdout);
  assert.match(offered.next[0].command, /decision completeness SCOPE-1 --confirm sha256:[0-9a-f]{64} --article /);
  sflow('decision', 'completeness', '--confirm', after.inventorySha256, ...articles, '--reason', 'Every source read against the six checklist articles.');
  const reviewed = JSON.parse(sflow('evidence', 'scope', '--json').stdout);
  assert.equal(reviewed.data.completenessReview.authorityGroup, 'product-approvers');
  assert.deepEqual(reviewed.next, [], 'a current review is not offered again');
  assert.match(sflow('evidence', 'scope').stdout, /Completeness reviewed: yes, by .+ through product-approvers/);
  const matrix = JSON.parse(sflow('evidence', 'matrix', '--format', 'json').stdout);
  const summary = (matrix.data?.matrix?.evaluation ?? matrix.evaluation ?? matrix).summary;
  assert.equal(summary.scope.completenessReviewed, true);
  const reviewedState = JSON.parse(await readFile(path.join(root, 'singularity/work-items/SCOPE-1/workflow.json'), 'utf8'));
  assert.equal(reviewedState.history.at(-1).event, 'completeness_reviewed');
  assert.equal(reviewedState.completenessReviews.at(-1).inventorySha256, after.inventorySha256);
});

/** A governed fixture Story whose intake (the step defining its scope) is published, not submitted. */
async function publishedScopeStory(t, id, { criteria = [], planned = [], sections = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-story-'));
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
  sflow('start', id, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value',
    '--description', 'The exported value must equal 2. The public API must stay stable.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, `singularity/work-items/${id}/artifacts/intake/intake.md`), [
    `# ${id} — intake`, '', '## Request and outcome', '', 'Change the exported value to 2.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${id}:AC-001] | The exported value must equal 2. |`, ...criteria, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | new | value() returns 2. |`, ...planned, '',
    ...sections,
    '## Initial evidence', '', 'The README at the pinned main revision.', '',
    '## Agent brief', '', 'Intake for a one-line value change; one criterion.', ''
  ].join('\n'));
  sflow('wm', 'compose', '--phase', 'intake');
  sflow('clarification', 'record', 'intake', '--question', 'Is the value 2?', '--answer', 'Yes.');
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  return { root, sflow };
}

test('the scope step\'s approver is shown each open statement while reviewing, and a statement its clauses carry is not open', async (t) => {
  const { root, sflow } = await publishedScopeStory(t, 'SCOPE-2');
  sflow('submit', 'intake');

  // Submission rewrote the document's status block, so its index is trusted only once approval
  // re-binds it; the approver still sees the scope as approval will leave it.
  const readiness = JSON.parse(sflow('status', 'SCOPE-2', '--submission-readiness', '--json').stdout);
  assert.equal(readiness.classification, 'already-submitted');
  const open = readiness.owedDecisions?.scopeItems ?? [];
  assert.deepEqual(open.map((item) => item.text), ['The public API must stay stable.'], JSON.stringify(readiness.owedDecisions));
  // Included or existing names its clauses and the rest refuse --clause, so each has its own command.
  assert.equal(open[0].command, `singularity-flow decision scope SCOPE-2 --item ${open[0].id} --as <included|existing> --clause <CLAUSE-ID> --reason "<why>"`);
  assert.equal(open[0].otherCommand, `singularity-flow decision scope SCOPE-2 --item ${open[0].id} --as <excluded|deferred|informative|duplicate|superseded> --reason "<why>"`);
  assert.deepEqual(readiness.owedDecisions.witnesses, []);
  assert.match(sflow('phase', 'show', 'intake').stdout, /Open scope items \(1, human only, approving intake waits for them\):\n {2}SRI-[0-9a-f]{12} story: "The public API must stay stable\."/u);
  // Approving before a person decides it is refused in the scope step itself, with the decision list as its route [PHR:REQ-002].
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'intake', '--yes', '--json'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /SCOPE_ITEMS_UNRESOLVED/u);

  sflow('decision', 'scope', '--item', open[0].id, '--as', 'excluded', '--reason', 'The API contract is out of scope for this Story.');
  assert.equal(JSON.parse(sflow('status', 'SCOPE-2', '--submission-readiness', '--json').stdout).owedDecisions, undefined);
  sflow('approve', 'intake', '--yes');
  const workflowState = JSON.parse(await readFile(path.join(root, 'singularity/work-items/SCOPE-2/workflow.json'), 'utf8'));
  assert.equal(workflowState.phases.intake.status, 'approved', 'a decision recorded during review does not stale the approval');
});

test('a sign-off commits its own new screenshot, and approval counts that commit as review-safe', async (t) => {
  // Outcome review: a visual check the plan named no screenshot path for. The person saves a screenshot
  // in the Story's evidence folder and signs off; the sign-off's commit carries exactly that image, so
  // the checkout stays clean, and a step under review is not held by it.
  const { root, sflow } = await publishedScopeStory(t, 'SCOPE-5', { sections: [
    '## Verification contracts', '', '| Criterion | Slot | Method | Witness | Role | Required assurance |', '|---|---|---|---|---|---|',
    '| `SCOPE-5:AC-001` | `screen` | visual | `the value screen` | primary | source-bound |', ''] });
  sflow('submit', 'intake');
  // The scope step is approved once its approver has dispositioned each statement [PHR:REQ-002].
  const [open] = JSON.parse(sflow('status', 'SCOPE-5', '--submission-readiness', '--json').stdout).owedDecisions.scopeItems;
  sflow('decision', 'scope', '--item', open.id, '--as', 'excluded', '--reason', 'The API contract is out of scope for this Story.');
  sflow('approve', 'intake', '--yes');
  const before = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const screenshot = 'singularity/work-items/SCOPE-5/evidence/ac-001-screen.png';
  await mkdir(path.join(root, path.dirname(screenshot)), { recursive: true });
  await writeFile(path.join(root, screenshot), 'a screenshot of the value screen');
  sflow('decision', 'witness', 'SCOPE-5', '--criterion', 'SCOPE-5:AC-001', '--slot', 'screen', '--file', screenshot,
    '--confirm', 'states-the-outcome', '--confirm', 'matches-the-criterion', '--confirm', 'current-for-this-change',
    '--reason', 'The value screen shows 2, as the criterion says.');
  assert.match(run('git', ['show', '--name-only', '--format=', 'HEAD'], root).stdout, /evidence\/ac-001-screen\.png/u,
    'the sign-off committed the screenshot it binds');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '', 'nothing is left for approval to refuse');
  // The approval gate's own classifier, over just that commit: review-safe, so it never holds a step.
  const { reviewHistoryCommits } = await import('../src/state.mjs');
  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/SCOPE-5/workflow.json'), 'utf8'));
  const history = await reviewHistoryCommits(root, definition, workflow, workflow.phases.intake, { evidenceCommit: before });
  assert.equal(history.interveningCommits.length, 1);
  assert.deepEqual(history.blocking, []);
});

test('only a sign-off\'s own visual screenshot in the evidence folder, byte for byte, rides with it', async () => {
  const { witnessEvidenceFile } = await import('../src/state.mjs');
  const item = 'singularity/work-items/W-1';
  const bytes = Buffer.from('screen');
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const record = { method: 'visual', file: `${item}/evidence/ac-001-screen.png`, sha256 };
  assert.equal(witnessEvidenceFile(item, record, bytes), record.file);
  assert.equal(witnessEvidenceFile(item, record, Buffer.from('other')), null, 'other bytes than the record binds');
  assert.equal(witnessEvidenceFile(item, { ...record, method: 'inspection' }, bytes), null, 'an inspection names a planned file');
  assert.equal(witnessEvidenceFile(item, { ...record, file: 'src/app.mjs' }, bytes), null, 'never product source');
  assert.equal(witnessEvidenceFile(item, { ...record, file: `${item}/evidence/../workflow.json` }, bytes), null);
  assert.equal(witnessEvidenceFile(item, record, null), null);
});

test('while the step defining scope is open, a decision names its own clauses and the inventory reads them', async (t) => {
  // graph-plot, 2026-10-26: the Specification asked for a scope decision, but decision scope knew only
  // approved clauses, so naming the Specification's own AC was refused until approval, and evidence
  // scope showed statements its draft already linked as open.
  const { sflow } = await publishedScopeStory(t, 'SCOPE-3', {
    criteria: ['| [SCOPE-3:AC-002] | Callers of the value module change nothing. |'],
    planned: ['| `SCOPE-3:AC-002` | `src/value.mjs` | `test/value.test.mjs` | modified | Existing callers still import value(). |']
  });
  const scope = () => JSON.parse(sflow('evidence', 'scope', 'SCOPE-3', '--json').stdout).data;
  const before = scope();
  assert.equal(before.preview, true, 'the open intake is read as a preview');
  const byText = (data, text) => data.scope.items.find((item) => item.text === text);
  assert.equal(byText(before, 'The exported value must equal 2.').disposition, 'included', 'its own clause carries it');
  const api = byText(before, 'The public API must stay stable.');
  assert.equal(api.disposition, 'unresolved');

  sflow('decision', 'scope', 'SCOPE-3', '--item', api.id, '--as', 'included', '--clause', 'SCOPE-3:AC-002',
    '--reason', 'Callers changing nothing is how this Story keeps the public API stable.');
  const after = byText(scope(), 'The public API must stay stable.');
  assert.equal(after.disposition, 'included');
  assert.deepEqual(after.clauseIds, ['SCOPE-3:AC-002']);
});

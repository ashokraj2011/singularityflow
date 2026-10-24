/**
 * Typed repository reads: fourteen closed questions, contained by construction. `[INT:IFC-040]`
 *
 * `typed-reads-stay-contained` is the acceptance test `[INT:AC-011]`: no read leaves the registered
 * root, follows an escaping symlink, executes shell syntax, or returns an excluded secret path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { REPOSITORY_QUERIES, repositoryQuery } from '../src/gateway/planners/repository-query.mjs';
import { validateArguments } from '../src/gateway/argument-schemas.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { run } from '../src/util.mjs';

const binding = {
  workspaceId: null, repository: 'checkout-service', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: 'dev@example.test', hostSessionId: 'sess-repository'
};

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

async function repository(t) {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-outside-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-repository-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(outside, 'private.txt'), 'outside-the-root-marker\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'checkout.mjs'), 'export function validate(address) {\n  return address.postal;\n}\n');
  await writeFile(path.join(root, '.env'), 'API_TOKEN=postal-secret-value\n');
  await symlink(path.join(outside, 'private.txt'), path.join(root, 'escape.txt'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'checkout validation');
  git(root, 'tag', 'v2.1.0');
  await writeFile(path.join(root, 'src', 'checkout.mjs'), 'export function validate(address) {\n  if (!address.postal) throw new Error("postal");\n  return address.postal;\n}\n');
  git(root, 'commit', '-q', '-am', 'missing postal codes fail closed');
  return { root, outside };
}

const query = (root, args) => repositoryQuery({ arguments: validateArguments('repository-query-v1', args), root, context: { repositoryId: 'checkout-service' } });

test('typed-reads-stay-contained', async (t) => {
  const { root, outside } = await repository(t);

  // Paths are repository-relative by schema: absolute paths and traversal never reach Git.
  for (const escape of ['/etc/hosts', '../outside/private.txt', 'src/../../private.txt', 'C:\\Windows']) {
    assert.throws(() => validateArguments('repository-query-v1', { query: 'blame', path: escape }), { code: 'INVALID_OPERATION_ARGUMENT' });
  }

  // An escaping symlink is its link text at a revision, never the file it points at.
  const viaLink = await query(root, { query: 'search', text: 'outside-the-root-marker' });
  assert.deepEqual(viaLink.data.facts, []);
  const linkBlame = await query(root, { query: 'blame', path: 'escape.txt', revision: 'HEAD' });
  assert.ok(linkBlame.data.facts.every((line) => !line.text.includes('outside-the-root-marker')));

  // Shell syntax is inert data: it reaches Git as one argv element, resolves to nothing, and runs nothing.
  const marker = path.join(outside, 'pwned');
  for (const revision of [`HEAD;touch${'$'}{IFS}${marker}`, '$(touch pwned)', '`touch pwned`']) {
    let refused;
    try { refused = await query(root, { query: 'log', revision }); } catch (error) { refused = error; }
    assert.ok(refused?.code === 'INVALID_OPERATION_ARGUMENT' || refused?.why?.[0]?.code === 'repository.query.revision-unresolved', revision);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(root, 'pwned')), false);

  // Pathspec magic in a value cannot widen the read: the path is literal.
  const magic = await query(root, { query: 'path-history', path: ':(glob)**' });
  assert.deepEqual(magic.data.facts, []);

  // A secret path is excluded from search, and the exclusion is reported rather than silent.
  const secret = await query(root, { query: 'search', text: 'postal' });
  assert.ok(secret.data.facts.length > 0);
  assert.ok(secret.data.facts.every((fact) => fact.path !== '.env'), 'a secret file was searched');
  assert.ok(secret.data.excludedPatterns.includes('**/.env'));

  // A repository this session is not bound to is refused, and nothing else is looked at.
  const elsewhere = await query(root, { query: 'status', repositoryId: 'order-orchestrator' });
  assert.deepEqual([elsewhere.kind, elsewhere.why[0].code], ['refusal', 'repository.query.not-registered']);

  // No read changed the repository: same HEAD, same index, same working tree.
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
});

test('every typed query answers with exact revisions and evidence handles', async (t) => {
  const { root } = await repository(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const first = git(root, 'rev-parse', 'HEAD~1').stdout.trim();
  const answers = {
    log: await query(root, { query: 'log', max: 5 }),
    commit: await query(root, { query: 'commit' }),
    'path-history': await query(root, { query: 'path-history', path: 'src/checkout.mjs' }),
    blame: await query(root, { query: 'blame', path: 'src/checkout.mjs', lineStart: 2, lineEnd: 2 }),
    diff: await query(root, { query: 'diff', path: 'src/checkout.mjs' }),
    'merge-base': await query(root, { query: 'merge-base', base: 'v2.1.0' }),
    contains: await query(root, { query: 'contains', revision: first }),
    'version-commit': await query(root, { query: 'version-commit', version: '2.1.0' }),
    branches: await query(root, { query: 'branches' }),
    tags: await query(root, { query: 'tags' }),
    status: await query(root, { query: 'status' }),
    search: await query(root, { query: 'search', text: 'throw' })
  };
  for (const [name, result] of Object.entries(answers)) {
    validateSflowResult(result);
    assert.equal(result.kind, 'read', name);
    assert.match(result.data.evidenceHandle, /^sha256:[0-9a-f]{64}$/, name);
    assert.ok(result.data.retrievedAt, name);
    assert.ok(result.data.tree, name);
    assert.ok(Object.values(result.effects).every((value) => value === false), name);
  }
  assert.equal(answers.commit.data.commit, head);
  assert.equal(answers.log.data.facts[0].commit, head);
  assert.equal(answers.blame.data.facts[0].commit, head);
  assert.equal(answers.blame.data.facts[0].line, 2);
  assert.equal(answers.diff.data.base, first);
  assert.equal(answers.diff.data.patch.binary, false);
  assert.match(answers.diff.data.patch.text, /fail|postal/);
  assert.equal(answers['merge-base'].data.facts[0].mergeBase, first);
  assert.deepEqual(answers.contains.data.facts.map((fact) => `${fact.kind}:${fact.name}`).sort(), ['branch:main', 'tag:v2.1.0']);
  assert.deepEqual(answers['version-commit'].data.facts[0], { version: '2.1.0', tag: 'v2.1.0', commit: first, mapping: 'exact-tag' });
  assert.equal(answers.status.data.tree, 'working-tree-and-index');
  assert.equal(answers.search.data.facts[0].path, 'src/checkout.mjs');

  // Two equal answers have one handle; a moved world has another.
  assert.equal((await query(root, { query: 'log', max: 5 })).data.evidenceHandle, answers.log.data.evidenceHandle);
  // A version no tag names is unmapped, never guessed.
  assert.equal((await query(root, { query: 'version-commit', version: '9.9.9' })).why[0].code, 'repository.query.version-unmapped');
  // A build has no commit until a provider says so with provenance.
  const build = await query(root, { query: 'build-commit', buildId: '8421' });
  assert.deepEqual([build.restState, build.why[0].code], ['unavailable', 'repository.query.build-provider-unavailable']);
  assert.ok(REPOSITORY_QUERIES.includes('build-commit'));
});

test('a typed query is reached only through resolution and a read handle', async (t) => {
  const { root } = await repository(t);
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root, plannerContext: { repositoryId: 'checkout-service' } });
  const resolved = await kernel.resolve({ utterance: 'who changed this line', arguments: { query: 'blame', path: 'src/checkout.mjs' } });
  assert.equal(resolved.kind, 'read');
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(read.operation.id, 'repository.query');
  assert.ok(read.data.facts.length >= 3);
  // Unknown fields — an argv, a command — are not arguments of the query.
  const argv = await kernel.resolve({ utterance: 'who changed this line', arguments: { query: 'blame', argv: ['--upload-pack=x'] } });
  assert.equal(argv.kind, 'refusal');
});

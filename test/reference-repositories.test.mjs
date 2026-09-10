import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import {
  materializeReferenceRepositories, parseReferenceRepositoryOptions,
  readReferenceRepositoryManifest, referenceRepositoryContextMarkdown, resolveReferenceRepositoryPins,
  storyReferenceRepositories, verifyReferenceRepositories, writeReferenceRepositoryManifest
} from '../src/reference-repositories.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow } from '../src/state.mjs';
import { run } from '../src/util.mjs';

function git(cwd, args) {
  return run('git', args, { cwd });
}

async function repositoryFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-reference-'));
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  const remote = path.join(directory, 'source.git');
  await mkdir(source);
  git(source, ['init', '--quiet', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Reference Author']);
  git(source, ['config', 'user.email', 'reference@example.test']);
  await writeFile(path.join(source, 'RuleEngine.java'), 'final class RuleEngine {}\n');
  git(source, ['add', 'RuleEngine.java']);
  git(source, ['commit', '--quiet', '-m', 'reference source']);
  git(directory, ['clone', '--quiet', '--bare', source, remote]);
  await mkdir(target);
  git(target, ['init', '--quiet', '--initial-branch=main']);
  git(target, ['config', 'user.name', 'Target Author']);
  git(target, ['config', 'user.email', 'target@example.test']);
  await writeFile(path.join(target, 'README.md'), '# target\n');
  git(target, ['add', 'README.md']);
  git(target, ['commit', '--quiet', '-m', 'target']);
  return { directory, source, target, remote };
}

test('reference repository intake requires paired explicit IDs, URLs, and branches', () => {
  const parsed = parseReferenceRepositoryOptions(
    ['java-rule-engine=https://example.test/team/rules.git'],
    ['java-rule-engine=release/2026-q3']
  );
  assert.deepEqual(parsed, [{
    id: 'java-rule-engine', repository: 'https://example.test/team/rules.git',
    requestedBranch: 'release/2026-q3', required: true
  }]);
  assert.throws(() => parseReferenceRepositoryOptions(
    ['Java Rules=https://example.test/rules.git'], ['Java Rules=main']
  ), /lower-case kebab case/);
  assert.throws(() => parseReferenceRepositoryOptions(
    ['rules=https://example.test/rules.git'], []
  ), /requires --reference-branch rules=/);
  assert.throws(() => parseReferenceRepositoryOptions(
    ['rules=https://user:secret@example.test/rules.git'], ['rules=main']
  ), /credential/i);
});

test('reference branches are pinned, detached, ignored, reproducible, and never silently repaired', async () => {
  const fixture = await repositoryFixture();
  try {
    await initializeDefinition(fixture.target);
    git(fixture.target, ['add', '.']);
    git(fixture.target, ['commit', '--quiet', '-m', 'initialize target governance']);
    git(fixture.target, ['switch', '--quiet', '-c', 'SPARK-1']);
    const requests = parseReferenceRepositoryOptions(
      [`java-rule-engine=${fixture.remote}`], ['java-rule-engine=main']
    );
    const pins = await resolveReferenceRepositoryPins(requests);
    assert.match(pins[0].commit, /^[0-9a-f]{40}$/);
    assert.equal(pins[0].requestedBranch, 'main');
    const references = await materializeReferenceRepositories(fixture.target, pins);
    assert.equal(references[0].materialization, 'created');
    assert.match(references[0].tree, /^[0-9a-f]{40}$/);
    const referencePath = path.join(fixture.target, references[0].localPath);
    assert.equal((await readFile(path.join(referencePath, 'RuleEngine.java'), 'utf8')).trim(),
      'final class RuleEngine {}');
    assert.equal(git(referencePath, ['branch', '--show-current']).stdout.trim(), '');
    assert.equal(git(fixture.target, ['status', '--porcelain=v1']).stdout.trim(), '');
    assert.match(await readFile(path.join(fixture.target, '.git/info/exclude'), 'utf8'),
      /^\/\.singularity-flow\/reference-repositories\/$/m);

    const ready = await verifyReferenceRepositories(fixture.target, references);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.repositories[0].status, 'ready');
    const reused = await materializeReferenceRepositories(fixture.target, references);
    assert.equal(reused[0].materialization, 'reused');

    const config = { workItemRoot: 'singularity/work-items' };
    const durable = references.map(({ materialization, ...reference }) => reference);
    await writeReferenceRepositoryManifest(fixture.target, config, 'SPARK-1', durable);
    const loaded = await readReferenceRepositoryManifest(fixture.target, config, 'SPARK-1');
    assert.equal(loaded.record.schemaVersion,
      currentSchemaVersion('story-reference-repository-set'));
    const workflow = { workItem: { id: 'SPARK-1' }, resolution: { referenceRepositories: durable } };
    assert.deepEqual(await storyReferenceRepositories(fixture.target, config, workflow), durable);
    assert.match(referenceRepositoryContextMarkdown(durable), /java-rule-engine/);
    assert.match(referenceRepositoryContextMarkdown(durable), new RegExp(durable[0].commit));

    const definition = await loadDefinition(fixture.target);
    definition.git.publish = 'off';
    await setAgentSession(fixture.target, definition, {
      name: 'Target Author', email: 'target@example.test', login: null
    }, 'product-owner', 'SPARK-1', { phaseId: 'specification', source: 'test' });
    const created = await createWorkflow(fixture.target, definition, {
      id: 'SPARK-1', title: 'Build a PySpark rules engine from Java references',
      source: {
        type: 'manual', key: 'SPARK-1', title: 'Build a PySpark rules engine from Java references',
        description: 'Create a new batch evaluator without changing the Java source.',
        acceptanceCriteria: ['The PySpark engine preserves the referenced rule semantics.']
      },
      baseBranch: 'main', workType: 'reference-driven-build', agent: 'product-owner',
      resolved: resolveWorkType(definition, 'reference-driven-build'),
      referenceRepositories: references
    });
    assert.equal(created.resolution.referenceRepositoryPolicy.mode, 'required');
    assert.deepEqual(created.resolution.referenceRepositories, durable);
    const specification = await readFile(path.join(
      fixture.target, 'singularity/work-items/SPARK-1/artifacts/specification/spec.md'
    ), 'utf8');
    assert.match(specification, /Read-only reference repositories/);
    assert.match(specification, /All delivery changes belong in the current Story repository/);
    const snapshot = JSON.parse(await readFile(path.join(
      fixture.target, created.workflowSnapshot.manifestPath
    ), 'utf8'));
    const frozenPolicy = JSON.parse(await readFile(path.join(fixture.target, snapshot.policy.path), 'utf8'));
    assert.deepEqual(frozenPolicy.referenceRepositories, durable);

    await writeFile(path.join(referencePath, 'RuleEngine.java'), 'changed locally\n');
    const blocked = await verifyReferenceRepositories(fixture.target, durable);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.repositories[0].status, 'invalid');
    await assert.rejects(materializeReferenceRepositories(fixture.target, durable),
      (error) => error.code === 'REFERENCE_REPOSITORY_TAMPERED');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

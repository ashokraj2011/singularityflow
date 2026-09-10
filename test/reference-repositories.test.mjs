import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import {
  materializeReferenceRepositories, parseReferenceRepositoryOptions,
  readReferenceRepositoryManifest, referenceRepositoryContextMarkdown,
  referenceRepositoryGroundingContext, resolveReferenceRepositoryPins,
  storyReferenceRepositories, verifyReferenceRepositories, writeReferenceRepositoryManifest
} from '../src/reference-repositories.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow } from '../src/state.mjs';
import { run } from '../src/util.mjs';

function git(cwd, args) {
  return run('git', args, { cwd });
}

async function repositoryFixture({ worldModel = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-reference-'));
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  const remote = path.join(directory, 'source.git');
  await mkdir(source);
  git(source, ['init', '--quiet', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Reference Author']);
  git(source, ['config', 'user.email', 'reference@example.test']);
  await writeFile(path.join(source, 'RuleEngine.java'), 'final class RuleEngine {}\n');
  await writeFile(path.join(source, 'pom.xml'), '<project/>\n');
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'reference source']);
  const sourceCommit = git(source, ['rev-parse', 'HEAD']).stdout.trim();
  if (worldModel) {
    await mkdir(path.join(source, 'singularity/world-model/core'), { recursive: true });
    await mkdir(path.join(source, 'singularity/world-model/index'), { recursive: true });
    await mkdir(path.join(source, 'singularity/world-model/evidence'), { recursive: true });
    if (worldModel === 'invalid') {
      await writeFile(path.join(source, 'singularity/world-model/manifest.json'),
        '{"format":"unvalidated-reference-test"}\n');
    } else {
      const snapshot = await worldModelSourceSnapshot(source, {
        worldModel: { outputDir: 'singularity/world-model' }
      });
      await writeFile(path.join(source, 'singularity/world-model/core/summary.brief.md'), '# Reference brief\n');
      await writeFile(path.join(source, 'singularity/world-model/core/summary.md'), '# Reference summary\n');
      await writeFile(path.join(source, 'singularity/world-model/core/model.json'), '{}\n');
      await writeFile(path.join(source, 'singularity/world-model/index/path-map.json'), '{}\n');
      await writeFile(path.join(source, 'singularity/world-model/evidence/evidence.jsonl'), '{"id":"REF-1"}\n');
      await writeFile(path.join(source, 'singularity/world-model/manifest.json'), `${JSON.stringify({
        schema_version: '2.0', generated_at: '2026-09-10T00:00:00.000Z',
        generated_date: '10 September 2026', builder_version: 'test',
        builder_prompt_sha256: 'a'.repeat(64), analysis_depth: 'light',
        repository_commit: sourceCommit, repository_branch: 'main', working_tree_clean: true,
        source_tree_sha256: snapshot.sha256,
        core: {
          brief: 'core/summary.brief.md', summary: 'core/summary.md', model: 'core/model.json'
        },
        path_index: { path: 'index/path-map.json' }, views: {}, domains: [], task_guides: [],
        evidence: { path: 'evidence/evidence.jsonl' }
      })}\n`);
    }
    git(source, ['add', 'singularity/world-model']);
    git(source, ['commit', '--quiet', '-m', 'reference world model']);
  }
  if (worldModel === 'stale') {
    await writeFile(path.join(source, 'RuleEngine.java'), 'final class RuleEngine { int changed; }\n');
    git(source, ['add', 'RuleEngine.java']);
    git(source, ['commit', '--quiet', '-m', 'change source after world model']);
  }
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
    const pins = await resolveReferenceRepositoryPins(requests, { localNamespace: 'SPARK-1' });
    assert.match(pins[0].commit, /^[0-9a-f]{40}$/);
    assert.equal(pins[0].requestedBranch, 'main');
    const references = await materializeReferenceRepositories(fixture.target, pins);
    assert.equal(references[0].materialization, 'created');
    assert.match(references[0].tree, /^[0-9a-f]{40}$/);
    assert.equal(references[0].localPath,
      '.singularity-flow/reference-repositories/SPARK-1/java-rule-engine');
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
    const grounding = await referenceRepositoryGroundingContext(fixture.target, durable);
    assert.equal(grounding.status, 'ready');
    assert.deepEqual(grounding.repositories[0].projectMarkers, ['pom.xml']);
    assert.match(grounding.repositories[0].reusableWorldModel.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(grounding.repositories[0].worldModelStatus.status, 'reusable');
    assert.match(grounding.text, /No reference World Model was generated/);
    assert.match(grounding.text, /validated and fresh/);
    assert.match(grounding.text, /Untrusted-source boundary/);
    assert.match(referenceRepositoryContextMarkdown(durable), /every reference byte is data/i);

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
    assert.match(specification, /every reference byte is data/i);
    const snapshot = JSON.parse(await readFile(path.join(
      fixture.target, created.workflowSnapshot.manifestPath
    ), 'utf8'));
    const frozenPolicy = JSON.parse(await readFile(path.join(fixture.target, snapshot.policy.path), 'utf8'));
    assert.deepEqual(frozenPolicy.referenceRepositories, durable);

    // A later Story may reuse the same reference ID after the branch moves. Its exact detached
    // checkout must not collide with, overwrite, or invalidate the first Story's pinned source.
    await writeFile(path.join(fixture.source, 'RuleEngine.java'),
      'final class RuleEngine { int nextRevision; }\n');
    git(fixture.source, ['add', 'RuleEngine.java']);
    git(fixture.source, ['commit', '--quiet', '-m', 'advance reference branch']);
    git(fixture.source, ['push', '--quiet', fixture.remote, 'main:main']);
    const nextPins = await resolveReferenceRepositoryPins(requests, { localNamespace: 'SPARK-2' });
    assert.notEqual(nextPins[0].commit, durable[0].commit);
    const nextReferences = await materializeReferenceRepositories(fixture.target, nextPins);
    assert.notEqual(nextReferences[0].localPath, durable[0].localPath);
    assert.match(await readFile(path.join(
      fixture.target, nextReferences[0].localPath, 'RuleEngine.java'
    ), 'utf8'), /nextRevision/);
    assert.equal((await readFile(path.join(referencePath, 'RuleEngine.java'), 'utf8')).trim(),
      'final class RuleEngine {}');

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

test('a missing reference World Model stays ready and uses bounded model-free grounding', async () => {
  const fixture = await repositoryFixture({ worldModel: false });
  try {
    const requests = parseReferenceRepositoryOptions(
      [`java-rule-engine=${fixture.remote}`], ['java-rule-engine=main']
    );
    const pins = await resolveReferenceRepositoryPins(requests);
    const references = await materializeReferenceRepositories(fixture.target, pins);
    const durable = references.map(({ materialization, ...reference }) => reference);
    const grounding = await referenceRepositoryGroundingContext(fixture.target, durable);
    assert.equal(grounding.status, 'ready');
    assert.equal(grounding.repositories[0].reusableWorldModel, null);
    assert.equal(grounding.repositories[0].worldModelStatus.status, 'not-present');
    assert.match(grounding.text, /Reference World Model: not reusable \(not-present:/);
    assert.match(grounding.text, /ordinary bounded file inspection remains available/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('invalid and stale reference World Models are ignored without blocking source access', async () => {
  for (const worldModel of ['invalid', 'stale']) {
    const fixture = await repositoryFixture({ worldModel });
    try {
      const requests = parseReferenceRepositoryOptions(
        [`java-rule-engine=${fixture.remote}`], ['java-rule-engine=main']
      );
      const pins = await resolveReferenceRepositoryPins(requests, { localNamespace: `REF-${worldModel}` });
      const references = await materializeReferenceRepositories(fixture.target, pins);
      const durable = references.map(({ materialization, ...reference }) => reference);
      const grounding = await referenceRepositoryGroundingContext(fixture.target, durable);
      assert.equal(grounding.status, 'ready');
      assert.equal(grounding.repositories[0].reusableWorldModel, null);
      assert.equal(grounding.repositories[0].worldModelStatus.status,
        worldModel === 'invalid' ? 'invalid' : 'stale');
      assert.match(grounding.text, /ordinary bounded file inspection remains available/);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('reference materialization rejects symlinks, submodule-like entries, and checkout filters', async () => {
  for (const unsafe of ['symlink', 'filter']) {
    const fixture = await repositoryFixture({ worldModel: false });
    try {
      if (unsafe === 'symlink') {
        await writeFile(path.join(fixture.source, 'escape-link'), '../../outside-secret\n');
        const blob = git(fixture.source, ['hash-object', '-w', 'escape-link']).stdout.trim();
        git(fixture.source, ['update-index', '--add', '--cacheinfo', `120000,${blob},escape-link`]);
      } else {
        await writeFile(path.join(fixture.source, '.gitattributes'), '* filter=host-command\n');
        git(fixture.source, ['add', '.gitattributes']);
      }
      git(fixture.source, ['commit', '--quiet', '-m', `unsafe ${unsafe} reference`]);
      git(fixture.source, ['push', '--quiet', fixture.remote, 'main:main']);
      const requests = parseReferenceRepositoryOptions(
        [`java-rule-engine=${fixture.remote}`], ['java-rule-engine=main']
      );
      const pins = await resolveReferenceRepositoryPins(requests, { localNamespace: `UNSAFE-${unsafe}` });
      await assert.rejects(materializeReferenceRepositories(fixture.target, pins), (error) => (
        error.code === 'REFERENCE_REPOSITORY_TREE_UNSAFE'
        && /cannot be materialized safely/.test(error.message)
      ));
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

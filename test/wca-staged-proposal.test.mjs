import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { proposeConfigurationChange } from '../src/configuration-proposal.mjs';
import { removeTemporaryTree } from '../src/util.mjs';

const bytesSha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const manifest = (relative, bytes, mode = '100644') => ({ path: relative, mode, bytes: bytes.length, sha256: bytesSha(bytes) });
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function fixture(t, { attributes = null, executableWorkflow = false, templatesRoot = 'singularity/templates', runtimeRoot = null, portfolioTemplatesRoot = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-staged-proposal-')); t.after(() => removeTemporaryTree(base));
  const root = path.join(base, 'client'); const remote = path.join(base, 'authority.git'); await mkdir(root);
  git(base, 'init', '--bare', '-q', remote); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Exact Stage Fixture'); git(root, 'config', 'user.email', 'exact-stage@example.test');
  await mkdir(path.join(root, templatesRoot), { recursive: true }); await mkdir(path.join(root, 'singularity'), { recursive: true });
  const workflow = Buffer.from(`version: 2\ntemplatesRoot: ${templatesRoot}\n${runtimeRoot ? `worldModel:\n  outputDir: ${runtimeRoot}\n` : ''}`); const existing = Buffer.from('# Retained template\n');
  await writeFile(path.join(root, 'singularity/workflow.yml'), workflow); await writeFile(path.join(root, templatesRoot, 'existing.md'), existing);
  if (portfolioTemplatesRoot) await writeFile(path.join(root, 'singularity/portfolio.yml'), `templatesRoot: ${portfolioTemplatesRoot}\n`);
  if (attributes) await writeFile(path.join(root, '.gitattributes'), attributes);
  git(root, 'add', '.'); if (executableWorkflow) git(root, 'update-index', '--chmod=+x', 'singularity/workflow.yml');
  git(root, 'commit', '-qm', 'approved fixture'); git(root, 'branch', 'sflow/config'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main', 'sflow/config');
  const observe = async () => ({ head: git(root, 'rev-parse', 'HEAD'), refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status: git(root, 'status', '--porcelain=v1'), index: await readFile(path.join(root, '.git/index')),
    remote: git(base, '--git-dir', remote, 'for-each-ref', '--format=%(refname) %(objectname)') });
  return { base, root, remote, workflow, existing, templatesRoot, observe, before: await observe(), env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Exact Stage Fixture' } };
}
async function propose(f, { bytes = Buffer.from('# Exact reviewed template\n'), expected = null, mutate = null, verify = true, relative = `${f.templatesRoot}/new.md` } = {}) {
  let stage;
  const result = await proposeConfigurationChange(f.root, { operation: 'exact-stage', subject: 'fixture', message: 'Private fixture review',
    mutate: async (scratch) => { await mkdir(path.dirname(path.join(scratch, relative)), { recursive: true }); await writeFile(path.join(scratch, relative), bytes); if (mutate) await mutate(scratch); return { reviewedSha256: bytesSha(bytes) }; },
    ...(verify ? { verifyStaged: (value) => { stage = value; return value.verifyFiles(expected ?? [manifest(relative, bytes), manifest('singularity/workflow.yml', f.workflow)]); } } : {})
  }, { env: f.env });
  return { result, stage, relative };
}
const refused = (error) => error.code === 'CONFIGURATION_PROPOSAL_REVIEWED_FILES_CHANGED';

test('exact staged tree verifies selected unchanged files and publishes only the reviewed bytes', async (t) => {
  const f = await fixture(t); const bytes = Buffer.from('# Exact reviewed bytes\n'); const { result, stage, relative } = await propose(f, { bytes });
  assert.equal(result.pushed, true); assert.deepEqual(stage.changedPaths, [relative]); assert.match(stage.candidateTree, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  const retained = spawnSync('git', ['--git-dir', f.remote, 'show', `${result.commit}:${relative}`], { encoding: null });
  assert.equal(retained.status, 0); assert.deepEqual(retained.stdout, bytes);
  const after = await f.observe(); assert.equal(after.head, f.before.head); assert.equal(after.status, f.before.status); assert.deepEqual(after.index, f.before.index);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), f.before.head);
});

test('Git text/EOL filters cannot change the reviewed candidate under the exact staged guard', async (t) => {
  const f = await fixture(t, { attributes: '*.md text eol=lf\n' });
  await assert.rejects(propose(f, { bytes: Buffer.from('# Literal CRLF\r\nSecond line\r\n') }), refused);
  assert.deepEqual(await f.observe(), f.before);
});

test('exact approved custom template roots admit reviewed files, including unchanged selected files', async (t) => {
  const f = await fixture(t, { templatesRoot: 'company/templates' }); const bytes = Buffer.from('# Approved custom-root candidate\n');
  const relative = 'company/templates/new.md';
  const { result } = await propose(f, { bytes, expected: [manifest(relative, bytes),
    manifest('company/templates/existing.md', f.existing), manifest('singularity/workflow.yml', f.workflow)] });
  assert.equal(result.pushed, true);
  assert.equal(git(f.base, '--git-dir', f.remote, 'show', `${result.commit}:${relative}`), bytes.toString('utf8').trim());
  const after = await f.observe(); assert.equal(after.head, f.before.head); assert.equal(after.status, f.before.status); assert.deepEqual(after.index, f.before.index);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), f.before.head);
});

test('an exact approved portfolio template root is part of the pre-change proposal policy', async (t) => {
  const f = await fixture(t, { portfolioTemplatesRoot: 'company/portfolio-templates' });
  const { result } = await propose(f, { relative: 'company/portfolio-templates/new.md' });
  assert.equal(result.pushed, true);
});

test('candidate root edits cannot authorize unapproved paths or remove approved runtime exclusions', async (t) => {
  for (const action of ['new-root', 'runtime-root']) await t.test(action, async (child) => {
    const f = await fixture(child, { templatesRoot: 'company/templates', runtimeRoot: 'company/templates/generated' });
    const bytes = Buffer.from('# Not approved for configuration\n');
    const relative = action === 'new-root' ? 'unapproved/templates/new.md' : 'company/templates/generated/new.md';
    const changedWorkflow = Buffer.from(`version: 2\ntemplatesRoot: ${action === 'new-root' ? 'unapproved/templates' : 'company/templates'}\nworldModel:\n  outputDir: unrelated/runtime\n`);
    await assert.rejects(propose(f, { bytes, relative, expected: [manifest(relative, bytes), manifest('singularity/workflow.yml', changedWorkflow)],
      mutate: (scratch) => writeFile(path.join(scratch, 'singularity/workflow.yml'), changedWorkflow) }),
    (error) => error.code === 'CONFIGURATION_PROPOSAL_SCOPE_INVALID');
    assert.deepEqual(await f.observe(), f.before);
  });
});

test('a reviewed ordinary mode cannot silently preserve an executable candidate entry', async (t) => {
  const f = await fixture(t, { executableWorkflow: true }); await assert.rejects(propose(f), refused);
  assert.deepEqual(await f.observe(), f.before);
});

test('unreviewed extra configuration paths and missing selected files fail before proposal publication', async (t) => {
  for (const action of ['extra', 'delete']) await t.test(action, async (child) => {
    const f = await fixture(child);
    await assert.rejects(propose(f, { mutate: async (scratch) => action === 'extra'
      ? writeFile(path.join(scratch, 'singularity/templates/extra.md'), '# Not reviewed\n')
      : unlink(path.join(scratch, 'singularity/templates/existing.md')) }), refused);
    assert.deepEqual(await f.observe(), f.before);
  });
});

test('index changes after verification cannot move the tree into a review branch', async (t) => {
  const f = await fixture(t); const bytes = Buffer.from('# Reviewed\n'); const relative = 'singularity/templates/new.md'; let scratchRoot;
  await assert.rejects(proposeConfigurationChange(f.root, { operation: 'exact-stage', subject: 'index-race',
    mutate: async (scratch) => { scratchRoot = scratch; await writeFile(path.join(scratch, relative), bytes); return {}; },
    verifyStaged: async (staged) => {
      staged.verifyFiles([manifest(relative, bytes)]);
      // This trusted fixture deliberately exercises the callback/index fence, not a production adapter.
      assert.equal(Object.isFrozen(staged.changedPaths), true);
      await writeFile(path.join(scratchRoot, relative), '# Changed after review verification\n'); git(scratchRoot, 'add', relative);
    }
  }, { env: f.env }), refused);
  assert.deepEqual(await f.observe(), f.before);
});

test('supplying a verifier that does not inspect the exact selected closure is refused', async (t) => {
  const f = await fixture(t);
  await assert.rejects(proposeConfigurationChange(f.root, { operation: 'exact-stage', subject: 'missing-check',
    mutate: async (scratch) => { await writeFile(path.join(scratch, 'singularity/templates/new.md'), '# Not inspected\n'); return {}; },
    verifyStaged: () => true
  }, { env: f.env }), refused);
  assert.deepEqual(await f.observe(), f.before);
});

test('a commit hook cannot publish a tree different from the exact verified index', async (t) => {
  const f = await fixture(t);
  await assert.rejects(propose(f, { mutate: async (scratch) => {
    await writeFile(path.join(scratch, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf "# Changed by commit hook\\n" > singularity/templates/new.md\ngit add singularity/templates/new.md\n', { mode: 0o755 });
  } }), refused);
  assert.deepEqual(await f.observe(), f.before);
});

test('a post-commit hook cannot reparent the exact reviewed tree away from the approved base', async (t) => {
  const f = await fixture(t);
  await assert.rejects(propose(f, { mutate: async (scratch) => {
    await writeFile(path.join(scratch, '.git/hooks/post-commit'), '#!/bin/sh\ntree=$(git write-tree)\nforeign=$(printf "Foreign parentless commit\\n" | git commit-tree "$tree") || exit 1\ngit update-ref HEAD "$foreign"\n', { mode: 0o755 });
  } }), refused);
  assert.deepEqual(await f.observe(), f.before);
});

test('legacy proposal callers without the optional verifier retain their existing staging behavior', async (t) => {
  const f = await fixture(t, { attributes: '*.md text eol=lf\n' }); const bytes = Buffer.from('# Legacy CRLF\r\n');
  const { result, relative } = await propose(f, { bytes, verify: false }); assert.equal(result.pushed, true);
  assert.equal(git(f.base, '--git-dir', f.remote, 'show', `${result.commit}:${relative}`), '# Legacy CRLF');
});

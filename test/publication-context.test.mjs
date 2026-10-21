import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseAst } from 'rollup/parseAst';
import { withPublicationContext, publicationGitRead, publicationGitResult } from '../src/publication-context.mjs';
import { gitDisabledHooksPath } from '../src/git-isolation-paths.mjs';

const root = path.join(os.tmpdir(), 'publication-context-fixture');
const oid = 'a'.repeat(40), other = 'b'.repeat(40);
const tree = ['ls-tree', '-z', oid, '--', 'owned/file'];
const options = { env: {}, maximumBytes: 1024 };

test('immutable reads share bytes only inside one publication and never share caller-owned buffers', async () => {
  let calls = 0;
  const read = env => { calls++; assert.equal(env.GIT_NO_LAZY_FETCH, '1'); return Buffer.from('exact'); };
  await withPublicationContext(root, async () => {
    publicationGitRead(root, tree, options, read)[0] = 0;
    assert.equal(publicationGitRead(root, tree, options, read).toString(), 'exact');
    assert.equal(calls, 1);
    publicationGitRead(root, ['ls-tree', '-z', other, '--', 'owned/file'], options, read);
    publicationGitRead(path.join(root, 'another'), tree, options, read);
    assert.equal(calls, 3);
  });
  publicationGitRead(root, tree, options, read);
  await withPublicationContext(root, async () => publicationGitRead(root, tree, options, read));
  assert.equal(calls, 5);
});

test('refs, worktree/index reads, input, relocating environments, limits and failures are never reused', async () => {
  await withPublicationContext(root, async () => {
    for (const args of [['rev-parse', 'HEAD'], ['ls-tree', '-z', 'HEAD', '--', 'owned/file'],
      ['diff', '--name-only', oid, other], ['diff', '--name-status', '-z', '--find-renames', '--find-copies', oid, other, '--'],
      ['symbolic-ref', 'HEAD'], ['read-tree', oid]]) {
      let calls = 0; const read = () => { calls++; return Buffer.from('answer'); };
      publicationGitRead(root, args, options, read); publicationGitRead(root, args, options, read);
      assert.equal(calls, 2, args.join(' '));
    }
    for (const special of [{ input: '' }, { env: { Git_Dir: '/different' } }, { maximumBytes: 2 }]) {
      let calls = 0; const read = () => { calls++; return Buffer.from('answer'); };
      const opts = { ...options, ...special };
      publicationGitRead(root, tree, opts, read); publicationGitRead(root, tree, opts, read);
      assert.equal(calls, 2);
    }
    let calls = 0;
    for (let i = 0; i < 2; i++) assert.throws(() => publicationGitRead(root, tree, options, () => {
      calls++; throw new Error('Git timed out');
    }), /Git timed out/u);
    assert.equal(calls, 2);
  });
});

test('only the exact kernel hook override is equivalent; configuration differences remain distinct', async () => {
  await withPublicationContext(root, async () => {
    let calls = 0; const read = () => { calls++; return Buffer.from('answer'); };
    publicationGitRead(root, tree, options, read);
    publicationGitRead(root, tree, { ...options, env: { GIT_INDEX_FILE: '/private/index', GIT_AUTHOR_NAME: 'fixture',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: gitDisabledHooksPath() } }, read);
    assert.equal(calls, 1);
    publicationGitRead(root, tree, { ...options, env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.renameLimit', GIT_CONFIG_VALUE_0: '1' } }, read);
    assert.equal(calls, 2);
  });
});

test('parallel and nested publications have independent bounded contexts', async () => {
  let calls = 0; const read = () => { calls++; return Buffer.from('answer'); };
  await Promise.all([0, 1].map(() => withPublicationContext(root, async () => {
    publicationGitRead(root, tree, options, read);
    await new Promise(resolve => setImmediate(resolve));
    publicationGitRead(root, tree, options, read);
    await withPublicationContext(root, async () => publicationGitRead(root, tree, options, read));
    publicationGitRead(root, tree, options, read);
  })));
  assert.equal(calls, 4);
});

test('writer metadata reuses exact object reads but preserves magic pathspec semantics and failures', async () => {
  let calls = 0;
  const execute = opts => { calls++; return { status: 0, stdout: 'exact\0', stderr: '', signal: null }; };
  await withPublicationContext(root, async () => {
    const args = ['rev-parse', `${oid}^{tree}`];
    assert.equal(publicationGitResult(root, args, options, execute).stdout, 'exact\0');
    assert.equal(publicationGitResult(root, args, options, execute).stdout, 'exact\0');
    assert.equal(calls, 1);
    for (let i = 0; i < 2; i++) publicationGitResult(root,
      ['ls-tree', '-z', oid, '--', ':(literal)owned/file'], options, opts => {
        assert.equal(opts.env.GIT_LITERAL_PATHSPECS, undefined); return execute(opts);
      });
    assert.equal(calls, 3);
    const failed = () => ({ status: 1, stdout: '', stderr: 'disk failure', signal: null });
    assert.equal(publicationGitResult(root, ['rev-parse', `${other}^{tree}`], options, failed).status, 1);
    assert.equal(publicationGitResult(root, ['rev-parse', `${other}^{tree}`], options, execute).status, 0);
    assert.equal(calls, 4);
  });
});

test('writer cache preserves binary bytes across encoding and obeys each caller buffer ceiling', async () => {
  let calls = 0;
  const raw = Buffer.from([0xff, 0x00]);
  const execute = opts => {
    calls++;
    assert.equal(opts.encoding, 'buffer');
    return { status: 0, stdout: raw, stderr: Buffer.alloc(0), signal: null };
  };
  await withPublicationContext(root, async () => {
    const args = ['ls-tree', '-r', '-z', oid];
    publicationGitResult(root, args, options, execute);
    assert.deepEqual(publicationGitResult(root, args, { ...options, encoding: 'buffer' }, execute).stdout, raw);
    assert.equal(calls, 1);
    publicationGitResult(root, args, { ...options, maxBuffer: 1 }, execute);
    assert.equal(calls, 2, 'oversized cached bytes cannot bypass the supplied process ceiling');
  });
});

test('the publication gateway cannot statically load legacy authoring, approval or model owners', async () => {
  const engine = new URL('../', import.meta.url), visited = new Set();
  const forbidden = new Set(['src/state.mjs', 'src/state-stores.mjs', 'src/initiative-state.mjs', 'src/phase-entry.mjs']);
  async function walk(file) {
    if (visited.has(file)) return;
    assert.ok(!forbidden.has(file), 'publication eagerly loaded ' + file);
    visited.add(file);
    const ast = parseAst(await readFile(new URL(file, engine), 'utf8'));
    for (const node of ast.body) if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)
      && node.source?.value.startsWith('.')) await walk(path.posix.normalize(path.posix.join(path.posix.dirname(file), node.source.value)));
  }
  await walk('src/story-publication-store.mjs');
  assert.ok(visited.size < 310, 'publication read/write closure grew to ' + visited.size);
  await walk('src/revision/publication-absence.mjs');
  assert.ok(!visited.has('src/revision/product-context.mjs'), 'absence must not hash the installed producer implementation');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  initializeLedger, publishToStateBranch, sha256
} from '../src/ledger.mjs';
import { run } from '../src/util.mjs';

const LEDGER = Object.freeze({
  enabled: true,
  branch: 'state',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
});

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-path-preconditions-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  run('git', ['init', '--bare', remote]);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'State Preconditions');
  git(root, 'config', 'user.email', 'state-preconditions@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# application\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'application root');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  await initializeLedger(root, LEDGER);
  return { root, remote };
}

function exact(contents, condition = 'absent-or-identical') {
  const bytes = Buffer.from(contents, 'utf8');
  return Object.freeze({
    condition,
    sha256: `sha256:${sha256(bytes)}`,
    bytes: bytes.length,
    gitMode: '100644'
  });
}

test('an immutable state path is create-if-absent and identical bytes are an idempotent reuse', async (t) => {
  const { root } = await repository(t);
  const target = 'singularity/world-model-history/objects/sha256/aa/aaaaaaaa';
  const contents = 'retained immutable object\n';
  const expectation = exact(contents);

  const first = await publishToStateBranch(root, LEDGER, { [target]: contents },
    'retain immutable object', {
      pathPreconditions: { [target]: expectation },
      exactBlobSha256: { [target]: expectation.sha256 }
    });
  assert.equal(first.changed, true);

  const reused = await publishToStateBranch(root, LEDGER, { [target]: contents },
    'reuse immutable object', {
      pathPreconditions: { [target]: expectation },
      exactBlobSha256: { [target]: expectation.sha256 }
    });
  assert.equal(reused.changed, false);
  assert.equal(git(root, 'show', `state:${target}`).stdout, contents);
});

test('a conflicting immutable state path is refused before staged bytes can replace it', async (t) => {
  const { root } = await repository(t);
  const target = 'singularity/world-model-history/models/bbbbbbbb.json';
  const winner = '{"winner":true}\n';
  const contender = '{"winner":false}\n';
  await publishToStateBranch(root, LEDGER, { [target]: winner }, 'publish winner', {
    pathPreconditions: { [target]: exact(winner) },
    exactBlobSha256: { [target]: exact(winner).sha256 }
  });

  await assert.rejects(
    () => publishToStateBranch(root, LEDGER, { [target]: contender }, 'replace winner', {
      pathPreconditions: { [target]: exact(contender) },
      exactBlobSha256: { [target]: exact(contender).sha256 }
    }),
    (error) => error?.code === 'state_branch.path_precondition_failed'
      && error?.details?.path === target
      && error?.details?.condition === 'absent-or-identical'
  );
  assert.equal(git(root, 'show', `state:${target}`).stdout, winner);
});

test('state path preconditions support strict absence and exact-presence checks', async (t) => {
  const { root } = await repository(t);
  const target = 'singularity/world-model-history/views/cccccccc.json';
  const contents = '{"view":true}\n';
  await publishToStateBranch(root, LEDGER, { [target]: contents }, 'seed exact path', {
    pathPreconditions: { [target]: { condition: 'absent' } },
    exactBlobSha256: { [target]: exact(contents).sha256 }
  });

  await assert.rejects(
    () => publishToStateBranch(root, LEDGER, { [target]: contents }, 'require absence', {
      pathPreconditions: { [target]: { condition: 'absent' } },
      exactBlobSha256: { [target]: exact(contents).sha256 }
    }),
    (error) => error?.code === 'state_branch.path_precondition_failed'
      && error?.details?.condition === 'absent'
  );
  const exactReuse = await publishToStateBranch(root, LEDGER, { [target]: contents },
    'require exact presence', {
      pathPreconditions: { [target]: exact(contents, 'exact') },
      exactBlobSha256: { [target]: exact(contents).sha256 }
    });
  assert.equal(exactReuse.changed, false);
});

test('exact state blobs bypass checkout line-ending filters', async (t) => {
  const { root } = await repository(t);
  await publishToStateBranch(root, LEDGER, {
    '.gitattributes': '*.txt text eol=crlf\n'
  }, 'install state filter');
  const target = 'singularity/world-model-history/objects/sha256/dd/dddddddd.txt';
  const contents = 'line one\nline two\n';
  const expectation = exact(contents);
  await publishToStateBranch(root, LEDGER, { [target]: contents }, 'publish exact bytes', {
    pathPreconditions: { [target]: expectation },
    exactBlobSha256: { [target]: expectation.sha256 }
  });
  assert.equal(git(root, 'show', `state:${target}`).stdout, contents);
});

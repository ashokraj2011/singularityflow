/** Resume the SDK's real prepared enrollment in another host process, without Git or providers. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { createFilesystemNamespaceStore } from '../../src/sda/filesystem-namespace-adapter.mjs';
import { createSqliteNamespaceStore } from '../../src/sda/sqlite-namespace-adapter.mjs';
import { openSqliteNamespaceJournal } from '../../src/sda/sqlite-namespace-journal.mjs';
import { createApplicationNamespaceStore } from '../../src/sda/application-namespace-adapter.mjs';
import { namespaceLimits } from '../../src/sda/namespace/contract.mjs';
import { openNativeSqliteDatabase } from '../../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../../src/sda/sqlite-content-adapter.mjs';

const input = JSON.parse(process.argv[2]), binding = { kind: 'shared' };
assert.ok(['filesystem','sqlite','application'].includes(input.backend));
const journal = input.backend === 'application' ? await openSqliteNamespaceJournal({ filename: path.join(input.directory, 'records.db'), binding, limits: namespaceLimits() }) : null;
const records = journal ? createApplicationNamespaceStore({ id: input.recordsId, qualification: 'test-only', binding }, { journal })
  : input.backend === 'filesystem' ? await createFilesystemNamespaceStore({ root: path.join(input.directory, 'records'), binding })
    : await createSqliteNamespaceStore({ filename: path.join(input.directory, 'records.db'), binding });
const database = await openNativeSqliteDatabase(path.join(input.directory, 'content.db'));
const content = createSqliteContentStore({ database, binding });
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (['node:child_process','node:fs','node:fs/promises'].includes(specifier) || /git-publication|state-stores|provider|cli\.mjs/.test(specifier)) {
    throw new Error('Unexpected enrollment host dependency: ' + specifier);
  }
  return next(specifier, context);
} });
try {
  const { createNamespaceProjectEngine } = await import('../../src/engine-storage/namespace-project.mjs');
  const access = { current: () => ({ projectId: input.scope.projectId, principalId: 'application-owner', permissions: ['project.enroll'] }) };
  const clock = { now() { throw new Error('A restarted intent cannot obtain a new timestamp.'); } };
  const engine = createNamespaceProjectEngine({ records, content, scope: input.scope, authority: input.authority, access, clock });
  const result = await engine.run('project.enroll', { operationId: input.operationId });
  assert.equal(result.replayed, false);
  process.stdout.write(JSON.stringify(result));
} finally { hooks.deregister(); records.close?.(); journal?.close(); database.close(); }

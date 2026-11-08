/** Empty real ports: the SDK, rather than fixture seed writes, must enroll the project. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemNamespaceStore } from '../../src/sda/filesystem-namespace-adapter.mjs';
import { createSqliteNamespaceStore } from '../../src/sda/sqlite-namespace-adapter.mjs';
import { openSqliteNamespaceJournal } from '../../src/sda/sqlite-namespace-journal.mjs';
import { createApplicationNamespaceStore } from '../../src/sda/application-namespace-adapter.mjs';
import { namespaceLimits } from '../../src/sda/namespace/contract.mjs';
import { openNativeSqliteDatabase } from '../../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../../src/sda/sqlite-content-adapter.mjs';
import { createNamespaceProjectEngine } from '../../src/engine-storage/namespace-project.mjs';
import { LIFECYCLE_AUTHORITY_KEY } from '../../src/engine-storage/namespace-lifecycle-contract.mjs';

export async function namespaceProjectFixture(t, { backend = 'filesystem' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-project-enrollment-')), binding = { kind: 'shared' };
  const scope = { projectId: 'new-project' }, authority = { id: 'application-authority', epoch: 1 };
  const journal = backend === 'application' ? await openSqliteNamespaceJournal({ filename: path.join(directory, 'records.db'), binding, create: true, limits: namespaceLimits() }) : null;
  const records = journal ? createApplicationNamespaceStore({ id: 'application-enrollment-fixture', qualification: 'test-only', binding }, { journal })
    : backend === 'filesystem' ? await createFilesystemNamespaceStore({ root: path.join(directory, 'records'), binding, create: true })
      : await createSqliteNamespaceStore({ filename: path.join(directory, 'records.db'), binding, create: true });
  const database = await openNativeSqliteDatabase(path.join(directory, 'content.db'));
  const content = createSqliteContentStore({ database, binding, create: true });
  t.after(async () => { records.close?.(); journal?.close(); database.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const control = { principalId: 'application-owner', permissions: ['project.enroll'], now: '2026-11-08T00:00:00.000Z', calls: 0, clockCalls: 0, hook: () => {} };
  const access = { async current(request) { control.calls++; await control.hook(control.calls, request);
    return { projectId: scope.projectId, principalId: control.principalId, permissions: [...control.permissions] }; } };
  const clock = { now() { control.clockCalls++; return control.now; } };
  const make = (options = {}) => createNamespaceProjectEngine({ records, content, scope, authority, access, clock, ...options });
  const readAuthority = () => records.read(scope, 'state', LIFECYCLE_AUTHORITY_KEY);
  const list = namespace => records.list(scope, namespace, { limit: 100 });
  return { backend, directory, records, content, scope, authority, access, clock, control, make, readAuthority, list, engine: make() };
}

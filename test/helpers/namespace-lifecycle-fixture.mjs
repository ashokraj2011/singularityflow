/** Explicit new-store enrollment fixture. It never migrates an installed Git project. */
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
import { createNamespaceLifecycleCommitter, namespaceLifecycleStoryKey } from '../../src/engine-storage/namespace-lifecycle-commit.mjs';
import { lifecycleRecord, LIFECYCLE_AUTHORITY_KEY } from '../../src/engine-storage/namespace-lifecycle-contract.mjs';

export async function namespaceLifecycleFixture(t, { backend = 'filesystem', recordsWrap = value => value, contentWrap = value => value } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-lifecycle-commit-'));
  const scope = { projectId: 'fixture-project' }, binding = { kind: 'shared' }, workId = 'PORTABLE-1', authority = { id: 'new-project', epoch: 1 };
  const journal = backend === 'application' ? await openSqliteNamespaceJournal({ filename: path.join(directory, 'records.db'), binding, create: true, limits: namespaceLimits() }) : null;
  const records = journal ? createApplicationNamespaceStore({ id: 'application-lifecycle-fixture', qualification: 'test-only', binding }, { journal })
    : backend === 'filesystem' ? await createFilesystemNamespaceStore({ root: path.join(directory, 'records'), binding, create: true })
      : await createSqliteNamespaceStore({ filename: path.join(directory, 'records.db'), binding, create: true });
  const database = await openNativeSqliteDatabase(path.join(directory, 'content.db'));
  const content = createSqliteContentStore({ database, binding, create: true });
  t.after(async () => { records.close?.(); journal?.close(); database.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const config = (await content.put(scope, 'config', Buffer.from('{"workflow":"fixture"}\n'))).reference;
  const configuration = { key: `versions/${config.sha256}`, content: config };
  const workflow = { workItem: { id: workId, branch: 'team/custom-source' }, currentPhase: 'team-document', history: [],
    phases: { 'team-document': { id: 'team-document', generation: 0, status: 'in_progress', artifacts: [],
      requiredArtifact: { path: 'artifacts/document.md', kind: 'requirements' },
      generationPolicy: { defaultProducer: 'external-tool', allowedProducers: ['external-tool'] } } } };
  const encode = value => Buffer.from(JSON.stringify(lifecycleRecord('state', { projectId: scope.projectId, workId,
    authorityId: authority.id, epoch: authority.epoch, configuration: config, workflow: value })) + '\n');
  const state = (await content.put(scope, 'state', encode(workflow))).reference;
  const headKey = namespaceLifecycleStoryKey(workId);
  const head = lifecycleRecord('head', { projectId: scope.projectId, workId, authorityId: authority.id, epoch: authority.epoch,
    sequence: 0, configuration, state, previous: null, operationId: 'enrollment' });
  const enrolled = lifecycleRecord('authority', { projectId: scope.projectId, authorityId: authority.id, epoch: authority.epoch,
    status: 'active', recordsId: records.descriptor.id, contentId: content.descriptor.id });
  await records.transact(scope, { operationId: 'enrollment', preconditions: [
    { namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, version: null }, { namespace: 'config', key: configuration.key, version: null },
    { namespace: 'state', key: headKey, version: null }
  ], changes: [
    { op: 'put', namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, immutable: false, value: enrolled },
    { op: 'put', namespace: 'config', key: configuration.key, immutable: true, value: lifecycleRecord('configuration', { projectId: scope.projectId, content: config }) },
    { op: 'put', namespace: 'state', key: headKey, immutable: false, value: head }
  ], events: [] });
  const make = () => createNamespaceLifecycleCommitter({ records: recordsWrap(records), content: contentWrap(content), scope, workId, authority });
  const proposal = (workflow, operationId = 'publish-1', extra = {}) => ({ operationId, operation: 'phase.publish', inputsSha256: 'a'.repeat(64),
    state: encode(workflow), evidence: [], ...extra });
  let sequence = 0;
  async function update(namespace, key, value) {
    const previous = await records.read(scope, namespace, key);
    return records.transact(scope, { operationId: `fixture-update-${++sequence}`, preconditions: [{ namespace, key, version: previous.record?.version ?? null }],
      changes: [{ op: 'put', namespace, key, immutable: false, value }], events: [] });
  }
  return { directory, records, content, scope, workId, authority, headKey, configuration, workflow, enrolled, encode, proposal, update, make, committer: make() };
}

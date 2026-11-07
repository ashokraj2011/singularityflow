/** Real metadata/content stores. Seed only a read projection; no lifecycle approval is fabricated. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemNamespaceStore } from '../../src/sda/filesystem-namespace-adapter.mjs';
import { createSqliteNamespaceStore } from '../../src/sda/sqlite-namespace-adapter.mjs';
import { openNativeSqliteDatabase } from '../../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../../src/sda/sqlite-content-adapter.mjs';
import { createNamespaceReadEngine, namespaceStoryReadKey } from '../../src/engine-storage/namespace-reader.mjs';
import { namespaceReadRecord, projectNamespaceReadState } from '../../src/engine-storage/namespace-read-contract.mjs';

export async function namespaceReadFixture(t, { backend = 'filesystem', workId = 'HEADLESS-1', contentWrap = value => value, recordsWrap = value => value } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-namespace-reader-'));
  const scope = { projectId: 'fixture-project' }, binding = { kind: 'shared' };
  const records = backend === 'filesystem' ? await createFilesystemNamespaceStore({ root: path.join(directory, 'records'), binding, create: true })
    : await createSqliteNamespaceStore({ filename: path.join(directory, 'records.db'), binding, create: true });
  const database = await openNativeSqliteDatabase(path.join(directory, 'content.db'));
  const opened = [database];
  const content = createSqliteContentStore({ database, binding, create: true });
  t.after(async () => { records.close?.(); for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const json = (namespace, value) => content.put(scope, namespace, Buffer.from(JSON.stringify(value) + '\n')).then(result => result.reference);
  let sequence = 0;
  const state = { workflow: null, policy: null, documents: null, head: null };
  async function head(value) {
    const key = namespaceStoryReadKey(workId), current = await records.read(scope, 'state', key);
    return records.transact(scope, { operationId: `read-fixture-${++sequence}`,
      preconditions: [{ namespace: 'state', key, version: current.record?.version ?? null }],
      changes: [{ op: 'put', namespace: 'state', key, immutable: false, value }], events: [] });
  }
  async function seed(workflow, documents, { workItemRoot = 'singularity/work-items', maximumPreviewBytes = 1_048_576 } = {}) {
    state.workflow = projectNamespaceReadState(workflow);
    state.policy = namespaceReadRecord('policy', { workItemRoot, maximumPreviewBytes });
    state.documents = namespaceReadRecord('documents', { documents });
    state.head = namespaceReadRecord('head', { projectId: scope.projectId, workId, state: await json('state', state.workflow),
      policy: await json('config', state.policy), documents: await json('state', state.documents) });
    await head(state.head);
  }
  const engine = createNamespaceReadEngine({ records: recordsWrap(records), content: contentWrap(content), scope, workId });
  async function document({ id = 'PHASE-BUILD', phase = 'build', generation = 1, sourceKey = `singularity/work-items/${workId}/artifacts/build/summary.md`,
    role = 'artifact', name = null, kind = 'implementation-summary', mimeType = 'text/markdown', encoding = 'utf8', locality = 'project',
    status = 'active', aliases = [], bytes = Buffer.from('Published summary.\n'), reference = null } = {}) {
    return { id, phase, generation, sourceKey, role, name, kind, mimeType, encoding, locality, status, aliases,
      content: reference ?? (await content.put(scope, 'evidence', bytes)).reference };
  }
  return { directory, database, opened, records, content, scope, workId, engine, json, head, seed, document, state, backend };
}

export function readWorkflow(workId, document, { phase = document.phase, submissions = [] } = {}) {
  return { workItem: { id: workId, branch: 'team/custom-branch' }, currentPhase: phase,
    phases: { [phase]: { id: phase, generation: document.generation, status: 'awaiting_approval',
      requiredArtifact: { path: `artifacts/${phase}/summary.md`, kind: document.kind },
      artifacts: [{ path: document.sourceKey, sha256: document.content.sha256, size: document.content.bytes, kind: document.kind }], agentBriefs: [] } },
    lineage: { canonicalBranch: 'team/custom-branch', childBranches: [], submissions },
    resolution: { documents: { maxPreviewBytes: 1_048_576 }, codeDelivery: { display: { previewBytes: 4096, fullDocumentMaximumBytes: 65536 } } } };
}

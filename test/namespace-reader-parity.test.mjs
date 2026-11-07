import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { publishedPlanningStory } from './helpers/submitted-planning-story.mjs';
import { namespaceReadFixture } from './helpers/namespace-read-fixture.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { phaseReviewSelection } from '../src/kernel/phase-policy.mjs';
import { phaseDocumentReference } from '../src/engine-compatibility/native-document-references.mjs';
import { createSflow } from '../src/api.mjs';

let machine, previous;
before(async () => { machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-namespace-read-native-'));
  previous = process.env; process.env = isolatedTestEnvironment(machine); });
after(async () => { process.env = previous; await rm(machine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('native retained documents keep their references, hashes and bodies in filesystem and SQLite read hosts', async t => {
  const workId = 'NS-READ-PARITY', source = await publishedPlanningStory(t, workId), api = createSflow({ root: source.root });
  const accepted = await loadAcceptedStoryExecution(source.root, workId), head = source.git('rev-parse', 'HEAD');
  const workflowBefore = await readFile(path.join(source.item, 'workflow.json'));
  const retained = [];
  for (const phaseId of ['specification','planning']) {
    const phase = accepted.workflow.phases[phaseId], review = await api.run('phase.review', { phaseId });
    const members = phaseReviewSelection(accepted.workflow, phaseId).retained;
    for (const item of review.manifest.items) {
      const member = members.find(member => phaseDocumentReference(workId, phase, { path: member.sourceKey, type: member.role }).id === item.reference.id);
      assert.ok(member, 'every retained reference has its original source binding');
      const body = await api.run('document.read', { reference: item.reference });
      retained.push({ phaseId, review, item, member, body: body.document, bytes: await readFile(path.join(source.root, member.sourceKey)) });
    }
  }
  assert.ok(retained.length >= 2);
  for (const backend of ['filesystem','sqlite']) {
    const f = await namespaceReadFixture(t, { backend, workId }), documents = [];
    for (const entry of retained) documents.push(await f.document({ id: entry.item.id, phase: entry.phaseId,
      generation: entry.item.reference.generation, sourceKey: entry.member.sourceKey, role: entry.item.role,
      name: entry.body.name, kind: entry.item.kind, mimeType: entry.item.mimeType,
      encoding: entry.item.observed.binary ? 'binary' : 'utf8', bytes: entry.bytes }));
    await f.seed(accepted.workflow, documents, { workItemRoot: accepted.definition.workItemRoot ?? 'singularity/work-items',
      maximumPreviewBytes: accepted.definition.documents?.maxPreviewBytes ?? 1_048_576 });
    for (const phaseId of ['specification','planning']) {
      const original = retained.find(entry => entry.phaseId === phaseId).review, read = await f.engine.run('phase.review', { phaseId });
      assert.deepEqual(read.manifest.items, original.manifest.items); assert.deepEqual(read.manifest.budgets, original.manifest.budgets);
      assert.equal(read.manifest.integrity, original.manifest.integrity); assert.equal(read.manifest.reviewBinding, null);
    }
    for (const entry of retained) assert.deepEqual((await f.engine.run('document.read', { reference: entry.item.reference })).document, entry.body);

    // A separate host has no repository, Git executable or native CLI module to fall back to.
    const empty = path.join(f.directory, 'empty-host'); await mkdir(empty);
    const child = path.join(empty, 'read.mjs');
    await writeFile(child, `
      import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,context,next){
        if(specifier==='node:child_process'||/(?:git|util|cli|state)\\.mjs$/.test(specifier))throw Error('Unexpected native host: '+specifier);
        return next(specifier,context);
      }});
      const {createNamespaceReadEngine}=await import(${JSON.stringify(new URL('../src/engine-storage/namespace-reader.mjs', import.meta.url).href)});
      const {openNativeSqliteDatabase}=await import(${JSON.stringify(new URL('../src/sda/sqlite-native.mjs', import.meta.url).href)});
      const {createSqliteContentStore}=await import(${JSON.stringify(new URL('../src/sda/sqlite-content-adapter.mjs', import.meta.url).href)});
      const db=await openNativeSqliteDatabase(${JSON.stringify(path.join(f.directory, 'content.db'))});
      let records;
      if(${JSON.stringify(backend)}==='filesystem'){
        const {createFilesystemNamespaceStore}=await import(${JSON.stringify(new URL('../src/sda/filesystem-namespace-adapter.mjs', import.meta.url).href)});
        records=await createFilesystemNamespaceStore({root:${JSON.stringify(path.join(f.directory, 'records'))},binding:{kind:'shared'}});
      }else{
        const {createSqliteNamespaceStore}=await import(${JSON.stringify(new URL('../src/sda/sqlite-namespace-adapter.mjs', import.meta.url).href)});
        records=await createSqliteNamespaceStore({filename:${JSON.stringify(path.join(f.directory, 'records.db'))},binding:{kind:'shared'}});
      }
      try{
        const content=createSqliteContentStore({database:db,binding:{kind:'shared'}});
        const engine=createNamespaceReadEngine({records,content,scope:${JSON.stringify(f.scope)},workId:${JSON.stringify(workId)}});
        const result=await engine.run('document.read',{reference:${JSON.stringify(retained[0].item.reference)}});
        process.stdout.write(JSON.stringify(result.document));
      }finally{records.close?.();db.close();}
    `);
    const result = spawnSync(process.execPath, [child], { cwd: empty, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr); assert.deepEqual(JSON.parse(result.stdout), retained[0].body);
  }
  assert.equal(source.git('rev-parse', 'HEAD'), head); assert.deepEqual(await readFile(path.join(source.item, 'workflow.json')), workflowBefore);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {openNativeSqliteDatabase} from '../src/sda/sqlite-native.mjs';
import {createSqliteContentStore} from '../src/sda/sqlite-content-adapter.mjs';

test('preparation reads an explicitly separate device input store; detach preserves original receipts and content',async t=>{
  const f=await namespaceEngineFixture(t);f.control.permissions.push('story.document.attach','story.document.detach','phase.enter','phase.context.read');await f.bootstrap();
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-separate-input-')),database=await openNativeSqliteDatabase(path.join(directory,'inputs.db')),
    documents=createSqliteContentStore({database,binding:{kind:'machine-local',deviceId:'input-device'},create:true});
  t.after(async()=>{database.close();await rm(directory,{recursive:true,force:true,maxRetries:5});});
  const bytes=Buffer.from('A real separately stored requirement document.\n'),content=(await documents.put(f.scope,'local',bytes)).reference,
    engine=f.make({localContent:documents}),request={operationId:'separate-document',workId:f.workId,documentId:'input-one',name:'Requirement input',
      mimeType:'text/plain',encoding:'utf8',content,reason:'Use this exact document in the privately authored phase.'},
    attached=await engine.run('story.document.attach',request);
  assert.equal((await f.local.content.read(f.scope,content)).status,'missing');
  const entry=await engine.run('phase.enter');assert.equal(entry.manifest.resources.filter(row=>row.kind==='supporting-document').length,1);
  await engine.run('phase.prepare',{phaseId:'intake'});
  const detached=await engine.run('story.document.detach',{operationId:'detach-document',workId:f.workId,documentId:'input-one',reason:'This reference is no longer an input for the remaining authoring.'});
  assert.equal(detached.document.status,'detached');assert.deepEqual((await documents.read(f.scope,content)).data,bytes);
  assert.equal((await f.content.read(f.scope,{...content,namespace:'evidence'})).status,'missing');
  assert.equal((await engine.run('phase.enter')).manifest.resources.filter(row=>row.kind==='supporting-document').length,0);
  assert.deepEqual(await engine.run('story.document.attach',request),attached);
  await assert.rejects(engine.run('story.document.attach',{...request,operationId:'reused-input-id'}),{code:'DOCUMENT_ID_REUSED'});
  assert.equal((await f.capture()).workflow.namespaceDocuments.filter(row=>row.kind==='input-document').length,1);
});

test('a lost attachment acknowledgement preserves the real error and resumes the exact accepted metadata without duplicates',async t=>{
  const f=await namespaceEngineFixture(t);f.control.permissions.push('story.document.attach');await f.bootstrap();
  const content=(await f.local.content.put(f.scope,'local',Buffer.from('The actual retained local document.'))).reference,
    input={operationId:'interrupted-input',workId:f.workId,documentId:'interrupted',name:'Local input',mimeType:'text/plain',encoding:'utf8',content,
      reason:'Keep the genuine input and reconcile an interrupted acknowledgement.'},
    timeout=Object.assign(new Error('The real attachment transaction reply timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:317}});let interrupted=false;
  const records={...f.records,async transact(...args){const receipt=await f.records.transact(...args);
    if(!interrupted&&args[1].events.some(row=>row.payload?.operation==='story.document.attach')){interrupted=true;throw timeout;}return receipt;}};
  await assert.rejects(f.make({records}).run('story.document.attach',input),error=>error===timeout);assert.equal(interrupted,true);
  const after=await f.capture(),accepted=await f.engine.run('story.document.attach',input);
  assert.equal(accepted.document.id,input.documentId);assert.deepEqual(await f.capture(),after);
  assert.equal(after.workflow.namespaceDocuments.filter(row=>row.kind==='input-document').length,1);
  assert.equal(after.workflow.namespaceDecisionReceipts.length,1);
});

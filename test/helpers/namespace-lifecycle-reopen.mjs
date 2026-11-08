/** Separate-process persistence qualification with explicit fixture ports and no installed discovery. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { createFilesystemNamespaceStore } from '../../src/sda/filesystem-namespace-adapter.mjs';
import { createSqliteNamespaceStore } from '../../src/sda/sqlite-namespace-adapter.mjs';
import { createApplicationNamespaceStore } from '../../src/sda/application-namespace-adapter.mjs';
import { openSqliteNamespaceJournal } from '../../src/sda/sqlite-namespace-journal.mjs';
import { namespaceLimits } from '../../src/sda/namespace/contract.mjs';
import { openNativeSqliteDatabase } from '../../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../../src/sda/sqlite-content-adapter.mjs';

const input=JSON.parse(process.argv[2]),binding={kind:'shared'};
assert.ok(['filesystem','sqlite','application'].includes(input.backend));
const journal=input.backend==='application'?await openSqliteNamespaceJournal({filename:path.join(input.directory,'records.db'),binding,limits:namespaceLimits()}):null;
const records=journal?createApplicationNamespaceStore({id:input.recordsId,qualification:'test-only',binding},{journal})
  :input.backend==='filesystem'?await createFilesystemNamespaceStore({root:path.join(input.directory,'records'),binding})
    :await createSqliteNamespaceStore({filename:path.join(input.directory,'records.db'),binding});
const database=await openNativeSqliteDatabase(path.join(input.directory,'content.db'));
const content=createSqliteContentStore({database,binding});
const hooks=registerHooks({resolve(specifier,context,next){
  if(['node:child_process','node:fs','node:fs/promises'].includes(specifier)||/git-publication|state-stores|provider|cli\.mjs/.test(specifier))throw new Error('Unexpected lifecycle host dependency: '+specifier);
  return next(specifier,context);
}});
try{
  const {createNamespaceLifecycleCommitter}=await import('../../src/engine-storage/namespace-lifecycle-commit.mjs');
  const committer=createNamespaceLifecycleCommitter({records,content,scope:input.scope,workId:input.workId,authority:input.authority});
  const first=await committer.commit(input.operationId),snapshot=await committer.capture(),again=await committer.commit(input.operationId);
  assert.equal(first.replayed,false);assert.equal(again.replayed,true);assert.deepEqual(again.receipt,first.receipt);
  const head=(await records.read(input.scope,'state',input.headKey)).record;
  const retained=await content.read(input.scope,head.value.state);
  process.stdout.write(JSON.stringify({workflow:snapshot.workflow,version:JSON.parse(Buffer.from(retained.data)).schemaVersion,receipt:first.receipt}));
}finally{hooks.deregister();records.close?.();journal?.close();database.close();}

import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(specifier,context,next){
  if(/\/(?:git|cli|state)\.mjs$/u.test(specifier))throw Error('An installed amendment cannot discover native Git, CLI or state');return next(specifier,context);
}}),{createNamespaceEngine}=await import('@sdk-name@/hosts/namespace-engine'),{createSqliteNamespaceStore}=await import('@sdk-name@/storage/sqlite'),
  {createSqliteContentStore}=await import('@sdk-name@/storage/sqlite-content'),selected=JSON.parse(process.argv[2]),binding={kind:'shared'},
  database=new DatabaseSync(path.join(selected.directory,'content.db')),records=await createSqliteNamespaceStore({filename:path.join(selected.directory,'records.db'),binding,create:false}),
  content=createSqliteContentStore({database,binding,create:false});
try{
  const engine=createNamespaceEngine({records,content,scope:selected.scope,workId:selected.workId,authority:selected.authority,access:{current:()=>selected.identity},
    clock:{now(){if(selected.replay)throw Error('Replay must retain its actual timestamp.');return selected.at;}}}),
    approved=await engine.run('forward-amendment.decide',selected.decision),reader=await engine.run('forward-amendment.revalidate',selected.revalidate);
  assert.equal(approved.records[0].approval.generation,2);assert.equal(reader.records[0].binding.producerGeneration,2);
  process.stdout.write(JSON.stringify([approved,reader]));
}finally{records.close?.();database.close();hook.deregister();}

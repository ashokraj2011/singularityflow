/** Actual installed source-origin and repository-plan takeover, independently bounded by unchanged deadlines. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';
import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),packageName='@singularity-flow/engine-sdk';
test('installed source provenance and repository plans survive checkout takeover',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-repository-plan-package-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const artifact=path.join(directory,'package'),consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp};
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const child=(executable,args,options)=>{const result=spawnSync(executable,args,{encoding:'utf8',timeout:60000,env,...options});
    assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;};
  const npm=(args,cwd)=>{const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,{cwd,...launch.spawnOptions});};
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"private":true,"type":"module"}\n');
  npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const run=async(name,source,args=[])=>{
    await writeFile(path.join(consumer,name),source);
    return child(process.execPath,[name,...args],{cwd:consumer,env:{...env,PATH:''}});
  };
  await t.test('installed repository plans preserve two approved local path projections across checkout takeover',async()=>{
    const source=(await readFile(new URL('./helpers/installed-namespace-specification.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName),
      first=JSON.parse(await run('repository-plan.mjs',source,['fresh','qualified'])),reopened=JSON.parse(await run('repository-plan.mjs',source,['reopen','qualified']));
    assert.deepEqual(reopened,first);assert.deepEqual(first.at(-1).clauses.repositories.map(row=>row.id),['app','service']);
    assert.equal(first.at(-1).clauses.profile,'sflow-planned-source-clause-observations/v2');
  });
  await t.test('installed v2 line-origin receipts replay real archived lines without the old checkout or Git',async sub=>{
    const {namespaceSourceClauseFixture}=await import('./helpers/namespace-source-clause-fixture.mjs');
    const f=await namespaceSourceClauseFixture(sub,{namespace:'SHARED',lineOrigins:true}),input={operationId:'clause-line-origins',workId:f.inputs.workId,phaseId:'build'},
      original=await f.engine.run('phase.source-control.retain',input),before=await f.head(),
      facts={...await f.access.current({projectId:f.scope.projectId,workId:f.inputs.workId,operation:'phase.source.retain'}),permissions:[],agentId:null};
    await rm(f.root,{recursive:true,force:true});
    const result=JSON.parse(await run('portable-line-origins.mjs',`
      import path from 'node:path';import assert from 'node:assert/strict';
      import {DatabaseSync} from 'node:sqlite';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceSourceControlEngine} from '${packageName}/hosts/namespace-source-control';
      import {SOURCE_CONTROL_READER_CONTRACT_V2,SOURCE_CONTROL_OBSERVATION_FORMAT_V2} from '${packageName}/source-control';
      assert.equal(SOURCE_CONTROL_READER_CONTRACT_V2,'sflow-source-control-reader/v2');
      assert.equal(SOURCE_CONTROL_OBSERVATION_FORMAT_V2,'sflow-source-control-observation/v2');
      const selected=JSON.parse(process.argv[2]),database=new DatabaseSync(path.join(selected.directory,'content.db'));
      database.enableDefensive(true);database.enableLoadExtension(false);
      const records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding:{kind:'shared'},create:false});
      try{const content=createSqliteContentStore({database,binding:{kind:'shared'},create:false});
        const engine=createNamespaceSourceControlEngine({records,content,scope:selected.scope,workId:selected.input.workId,authority:selected.authority,
          access:{current:()=>selected.facts},clock:{now(){throw Error('Do not restamp accepted line origins.');}}});
        process.stdout.write(JSON.stringify(await engine.run('phase.source-control.retain',selected.input)));
      }finally{records.close?.();database.close();}
    `,[JSON.stringify({directory:f.directory,scope:f.scope,authority:f.authority,input,facts})]));
    assert.equal(result.status,'retained');assert.deepEqual(result.record,original.record);assert.deepEqual(await f.head(),before);
  });
});

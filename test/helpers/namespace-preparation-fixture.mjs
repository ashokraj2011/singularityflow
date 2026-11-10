/** A real enrolled/configured Story with separately device-bound private working storage. */
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { namespaceStoryFixture } from './namespace-story-fixture.mjs';
import { createFilesystemNamespaceStore } from '../../src/sda/filesystem-namespace-adapter.mjs';
import { createSqliteNamespaceStore } from '../../src/sda/sqlite-namespace-adapter.mjs';
import { createApplicationNamespaceStore } from '../../src/sda/application-namespace-adapter.mjs';
import { openSqliteNamespaceJournal } from '../../src/sda/sqlite-namespace-journal.mjs';
import { openNativeSqliteDatabase } from '../../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../../src/sda/sqlite-content-adapter.mjs';
import { namespaceLimits } from '../../src/sda/namespace/contract.mjs';
import { createNamespacePreparationEngine } from '../../src/engine-storage/namespace-preparation.mjs';
import { createFilesystemSourceUnit } from '../../src/sgos/filesystem-source-unit.mjs';
import { createNamespaceSourceEngine } from '../../src/engine-storage/namespace-source.mjs';

export async function namespacePreparationFixture(t,{backend='filesystem',code=false,configure=null,storyText}={}) {
  const f=await namespaceStoryFixture(t,{backend});
  let inputs=f.inputs;
  if(code||configure) {
    const source=structuredClone(f.configurationSource);
    if(code) {
      source.definition.phases.intake.generation={producer:'governed-agent',task:'code'};
      source.definition.phases.intake.writeScope='source-and-artifact';
      source.definition.phases.intake.artifact.kind='implementation-summary';
      source.definition.workTypes.simple.omits=source.definition.workTypes.simple.omits.filter(item=>item.responsibility!=='implement');
    }
    if(configure)await configure(source);
    const operationId=code?'configuration-code':'configuration-custom';
    const reference=await f.store(source);
    await f.configurationEngine.run('configuration.approve',{...f.configurationInputs,operationId,source:reference,
      confirm:reference.sha256,expectedRevision:f.approval.revision});
    inputs={...inputs,configurationId:operationId};
  }
  if(storyText!==undefined)inputs={...inputs,source:(await f.content.put(f.scope,'state',Buffer.from(storyText))).reference};
  const story=await f.engine.run('story.create',inputs);
  const privateDirectory=await mkdtemp(path.join(os.tmpdir(),'sflow-private-preparation-')),binding={kind:'machine-local',deviceId:'test-device'};
  const journal=backend==='application'?await openSqliteNamespaceJournal({filename:path.join(privateDirectory,'records.db'),binding,create:true,limits:namespaceLimits()}):null;
  const localRecords=journal?createApplicationNamespaceStore({id:'local-application-fixture',qualification:'test-only',binding},{journal})
    :backend==='filesystem'?await createFilesystemNamespaceStore({root:path.join(privateDirectory,'records'),binding,create:true})
      :await createSqliteNamespaceStore({filename:path.join(privateDirectory,'records.db'),binding,create:true});
  const database=await openNativeSqliteDatabase(path.join(privateDirectory,'content.db')),localContent=createSqliteContentStore({database,binding,create:true});
  t.after(async()=>{localRecords.close?.();journal?.close();database.close();await rm(privateDirectory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  Object.assign(f.control,{draftCalls:0,draftHook:()=>{},agentId:'analyst',permissions:[...f.control.permissions,
    'phase.prepare','phase.draft.read','phase.draft.write','phase.draft.rebase','source.bind']});
  const access={async current(request){f.control.draftCalls++;await f.control.draftHook(f.control.draftCalls,request);
    return {projectId:f.scope.projectId,principalId:f.control.principalId,actorKind:f.control.actorKind,identity:structuredClone(f.control.creator),
      agentId:f.control.agentId,permissions:[...f.control.permissions]};}};
  let unit=null,sourceRoot=null;
  if(code) {
    sourceRoot=path.join(f.directory,'checkout');await mkdir(sourceRoot);await writeFile(path.join(sourceRoot,'app.js'),'export const answer = 42;');
    unit=await createFilesystemSourceUnit({root:sourceRoot,id:'app-checkout',projectId:f.scope.projectId,repositoryId:'app'});
    await createNamespaceSourceEngine({records:f.records,content:f.content,scope:f.scope,workId:inputs.workId,authority:f.authority,
      sources:[unit],access,clock:f.clock}).run('source.bind',{operationId:'bind-code-source',workId:inputs.workId,expectedRevision:story.revision,
        repositories:['app'],reason:'Bind the actual first code baseline.'});
  }
  const make=(options={})=>createNamespacePreparationEngine({records:f.records,content:f.content,localRecords,localContent,scope:f.scope,
    workId:f.inputs.workId,authority:f.authority,access,clock:f.clock,sources:unit?[unit]:[],...options});
  const upload=async text=>(await localContent.put(f.scope,'local',Buffer.from(text))).reference;
  const read=engine=>engine.run('phase.draft.read',{workId:f.inputs.workId,phaseId:'intake'});
  return {...f,story,inputs,unit,sourceRoot,privateDirectory,localRecords,localContent,access,make,upload,read,engine:make()};
}

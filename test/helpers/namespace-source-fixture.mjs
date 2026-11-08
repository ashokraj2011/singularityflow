/** A real enrolled/configured Story plus an actual filesystem source unit. */
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { namespaceStoryFixture } from './namespace-story-fixture.mjs';
import { createFilesystemSourceUnit } from '../../src/sgos/filesystem-source-unit.mjs';
import { createNamespaceSourceEngine } from '../../src/engine-storage/namespace-source.mjs';

export async function namespaceSourceFixture(t,{backend='filesystem'}={}) {
  const f=await namespaceStoryFixture(t,{backend}),story=await f.engine.run('story.create',f.inputs);
  const root=path.join(f.directory,'checkout');await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src/main.js'),'export const answer = 42;\n');
  const unit=await createFilesystemSourceUnit({root,id:'app-checkout',projectId:f.scope.projectId,repositoryId:'app'});
  Object.assign(f.control,{sourceCalls:0,sourceHook:()=>{},permissions:[...f.control.permissions,'source.bind']});
  const access={async current(request){f.control.sourceCalls++;await f.control.sourceHook(f.control.sourceCalls,request);
    return {projectId:f.scope.projectId,principalId:f.control.principalId,actorKind:f.control.actorKind,
      identity:structuredClone(f.control.creator),permissions:[...f.control.permissions]};}};
  const make=(options={})=>createNamespaceSourceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority,sources:[unit],access,clock:f.clock,...options});
  const inputs={operationId:'bind-sources-1',workId:f.inputs.workId,expectedRevision:story.revision,repositories:['app'],reason:'Bind the actual checkout used for this Story.'};
  return {...f,story,storyInputs:f.inputs,root,unit,make,inputs,engine:make()};
}

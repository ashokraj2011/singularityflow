/** Real independent scope/plan approvals, source selection, private generation and retained bytes. */
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {namespaceSpecificationFixture,specificationText,planText} from './namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../../src/sgos/filesystem-source-unit.mjs';
import {pinnedLocalGit} from './pinned-local-git.mjs';
import {createNodeGitSourceControlReader} from '../../src/sgos/node-git-source-control-reader.mjs';
export const converterSource='// @clause:STORY-1:REQ-001 Converts the selected integer into hexadecimal.\n'
  +'// @clause:STORY-1:AC-001 Returns FF for the approved 255 example.\nexport const convert=value=>value.toString(16).toUpperCase();\n';
export async function namespaceSourceClauseFixture(t,{backend='filesystem',configure=()=>{},source=converterSource,baselineSource='export const convert=value=>String(value);\n',
  retainBaseline=true,retainChanges=true,repositories=1,namespace='STORY-1',lineOrigins=false,originalSource=baselineSource,retainOrigins=true,plan=planText,
  beforeCode=null,beforePrepare=null,afterPrepare=null,approveScope=null,beforeSpecification=null,baselineTestSource='// Original test source.\n',testSource=null,specification=specificationText,storyText=undefined}={}) {
  const f=await namespaceSpecificationFixture(t,{backend,storyText,beforeSpecification,configure:definition=>{
    definition.definition.spec.namespace=namespace;
    definition.definition.codeDelivery={traceability:{sourceBindings:'enforce'}};configure(definition);
  }}),replace=text=>text.replaceAll('STORY-1:',namespace+':');
  await f.author('intake',replace(specification));if(approveScope)await approveScope(f);else await f.approve('intake');
  await f.author('design',replace(plan));if(beforeCode)await beforeCode(f,replace(plan));else await f.approve('design');
  f.control.permissions.push('source.baseline.retain','phase.source.retain','phase.source.inspect');
  const sources=[],sourceReaders=[],roots=[],gitBindings=[],binary=lineOrigins?await pinnedLocalGit():null;
  for(let index=0;index<repositories;index++) {
    const root=path.join(f.directory,'source-clauses-'+index);await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'test'));
    await writeFile(path.join(root,'src/converter.js'),replace(lineOrigins?originalSource:baselineSource));
    await writeFile(path.join(root,'test/converter.test.js'),replace(baselineTestSource));
    if(lineOrigins){const git=(...args)=>execFileSync(binary.executable,args,{cwd:root,encoding:'utf8',env:process.env,timeout:15000}).trim();
      git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');
      git('config','core.ignorecase','false');git('add','src','test');git('commit','-qm','Original Story source');
      gitBindings.push({git,origin:git('rev-parse','HEAD'),baseline:git('rev-parse','HEAD')});}
    const unit=await createFilesystemSourceUnit({root,id:'clause-source-'+index,projectId:f.scope.projectId,repositoryId:index?'service-'+index:'app'});
    sources.push(unit);sourceReaders.push(await createFilesystemSourceContentReader({root,id:'clause-content-'+index,source:unit.descriptor}));roots.push(root);
  }
  const options={...f.common,working:{records:f.localRecords,content:f.localContent},sources,sourceReaders},make=extra=>createNamespaceEngine({...options,...extra}),engine=make();
  await engine.run('source.bind',{operationId:'clause-source-selection',workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,
    repositories:sources.map(unit=>unit.descriptor.repositoryId),reason:'Bind the real source after its exact plan was independently approved.'});
  if(retainBaseline)await engine.run('source.baseline.retain',{operationId:'clause-original-bytes',workId:f.inputs.workId,sourceBindingId:'clause-source-selection'});
  let sourceBindingId='clause-source-selection';
  if(lineOrigins&&originalSource!==baselineSource){
    for(const [index,root]of roots.entries()){await writeFile(path.join(root,'src/converter.js'),replace(baselineSource));const {git}=gitBindings[index];git('add','src');git('commit','-qm','Earlier authored source');gitBindings[index].baseline=git('rev-parse','HEAD');}
    sourceBindingId='clause-generation-selection';
    await engine.run('source.bind',{operationId:sourceBindingId,workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,repositories:sources.map(unit=>unit.descriptor.repositoryId),reason:'Bind the real later-generation baseline while preserving the first Story origin.'});
    if(retainBaseline)await engine.run('source.baseline.retain',{operationId:'clause-generation-bytes',workId:f.inputs.workId,sourceBindingId});
  }
  if(beforePrepare)await beforePrepare(f,engine,roots);
  await engine.run('phase.prepare',{phaseId:'build'});
  if(afterPrepare)await afterPrepare(f,engine,roots);
  for(const [index,root]of roots.entries()) {
    const authored=typeof source==='function'?source(index):source;
    if(authored===null)await rm(path.join(root,'src/converter.js'));else await writeFile(path.join(root,'src/converter.js'),replace(authored));
    await writeFile(path.join(root,'test/converter.test.js'),testSource===null?"// @ac:"+namespace+":AC-001\n// An authored regression is not executed evidence.\n":replace(testSource));
  }
  const retain=(operationId='clause-current-bytes')=>engine.run('phase.source.retain',{operationId,workId:f.inputs.workId,phaseId:'build'});
  if(retainChanges)await retain();
  let active=engine;
  if(lineOrigins){options.sourceControlReaders=await Promise.all(roots.map((root,index)=>createNodeGitSourceControlReader({
    id:'clause-git-'+index,root,source:sources[index].descriptor,baselineCommit:gitBindings[index].baseline,originCommit:gitBindings[index].origin,git:binary,authorizeCapture:()=>true})));
    active=make();if(retainOrigins)await active.run('phase.source-control.retain',{operationId:'clause-line-origins',workId:f.inputs.workId,phaseId:'build'});
  }
  return {...f,options,make,engine:active,sourceBindingId,gitBindings,sources,sourceReaders,roots,root:roots[0],retain,inspect:input=>active.run('phase.delivery.inspect',{phaseId:'build',...input})};
}

/** Real independent scope/plan approvals, source selection, private generation and retained bytes. */
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {namespaceSpecificationFixture,specificationText,planText} from './namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../../src/sgos/filesystem-source-unit.mjs';
export const converterSource='// @clause:STORY-1:REQ-001 Converts the selected integer into hexadecimal.\n'
  +'// @clause:STORY-1:AC-001 Returns FF for the approved 255 example.\nexport const convert=value=>value.toString(16).toUpperCase();\n';
export async function namespaceSourceClauseFixture(t,{backend='filesystem',configure=()=>{},source=converterSource,baselineSource='export const convert=value=>String(value);\n',
  retainBaseline=true,retainChanges=true,repositories=1,namespace='STORY-1'}={}) {
  const f=await namespaceSpecificationFixture(t,{backend,configure:definition=>{
    definition.definition.spec.namespace=namespace;
    definition.definition.codeDelivery={traceability:{sourceBindings:'enforce'}};configure(definition);
  }}),replace=text=>text.replaceAll('STORY-1:',namespace+':');
  await f.author('intake',replace(specificationText));await f.approve('intake');
  await f.author('design',replace(planText));await f.approve('design');
  f.control.permissions.push('source.baseline.retain','phase.source.retain','phase.source.inspect');
  const sources=[],sourceReaders=[],roots=[];
  for(let index=0;index<repositories;index++) {
    const root=path.join(f.directory,'source-clauses-'+index);await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'test'));
    await writeFile(path.join(root,'src/converter.js'),replace(baselineSource));
    await writeFile(path.join(root,'test/converter.test.js'),'// Original test source.\n');
    const unit=await createFilesystemSourceUnit({root,id:'clause-source-'+index,projectId:f.scope.projectId,repositoryId:index?'service-'+index:'app'});
    sources.push(unit);sourceReaders.push(await createFilesystemSourceContentReader({root,id:'clause-content-'+index,source:unit.descriptor}));roots.push(root);
  }
  const options={...f.common,working:{records:f.localRecords,content:f.localContent},sources,sourceReaders},make=extra=>createNamespaceEngine({...options,...extra}),engine=make();
  await engine.run('source.bind',{operationId:'clause-source-selection',workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,
    repositories:sources.map(unit=>unit.descriptor.repositoryId),reason:'Bind the real source after its exact plan was independently approved.'});
  if(retainBaseline)await engine.run('source.baseline.retain',{operationId:'clause-original-bytes',workId:f.inputs.workId,sourceBindingId:'clause-source-selection'});
  await engine.run('phase.prepare',{phaseId:'build'});
  for(const root of roots) {
    if(source===null)await rm(path.join(root,'src/converter.js'));else await writeFile(path.join(root,'src/converter.js'),replace(source));
    await writeFile(path.join(root,'test/converter.test.js'),"// @ac:"+namespace+":AC-001\n// An authored regression is not executed evidence.\n");
  }
  const retain=(operationId='clause-current-bytes')=>engine.run('phase.source.retain',{operationId,workId:f.inputs.workId,phaseId:'build'});
  if(retainChanges)await retain();
  return {...f,options,make,engine,sources,sourceReaders,roots,root:roots[0],retain,inspect:input=>engine.run('phase.delivery.inspect',{phaseId:'build',...input})};
}

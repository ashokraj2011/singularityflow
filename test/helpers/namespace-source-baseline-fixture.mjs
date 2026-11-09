/** Real original files and accepted source selection, with device-local uploads kept out of archives. */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespacePreparationFixture} from './namespace-preparation-fixture.mjs';
import {createFilesystemSourceContentReader} from '../../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceSourceEngine} from '../../src/engine-storage/namespace-source.mjs';
import {createNamespaceSourceBaselineEngine} from '../../src/engine-storage/namespace-source-baseline.mjs';
export async function namespaceSourceBaselineFixture(t,{backend='filesystem'}={}){
  const f=await namespacePreparationFixture(t,{backend,code:true});f.control.permissions.push('source.baseline.retain','phase.source.retain');
  const binary=Buffer.from(Array.from({length:200_000},(_,index)=>(index*17)%251)),localDocument='DEVICE-LOCAL-BASELINE-UPLOAD-MUST-NOT-BE-SHARED';
  await writeFile(path.join(f.sourceRoot,'binary.bin'),binary);await writeFile(path.join(f.sourceRoot,'empty.js'),'');
  await writeFile(path.join(f.sourceRoot,'package.json'),'{}');await writeFile(path.join(f.sourceRoot,'gone.js'),'export const gone = true;');
  const uploadPath=path.join(f.sourceRoot,'singularity/work-items',f.inputs.workId,'inputs','upload.txt');
  await mkdir(path.dirname(uploadPath),{recursive:true});await writeFile(uploadPath,localDocument);
  const selectionId='baseline-content-selection';
  await createNamespaceSourceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,sources:[f.unit],access:f.access,clock:f.clock})
    .run('source.bind',{operationId:selectionId,workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,repositories:['app'],reason:'Retain the actual original application selection.'});
  const sourceReader=await createFilesystemSourceContentReader({root:f.sourceRoot,id:'baseline-content-reader',source:f.unit.descriptor,maximumChunkBytes:8192});
  const options={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,sources:[f.unit],sourceReaders:[sourceReader],access:f.access,clock:f.clock};
  const make=extra=>createNamespaceSourceBaselineEngine({...options,...extra});
  return {...f,binary,localDocument,uploadPath,sourceReader,options,make,engine:make(),input:{operationId:'archive-baseline',workId:f.inputs.workId,sourceBindingId:selectionId}};
}

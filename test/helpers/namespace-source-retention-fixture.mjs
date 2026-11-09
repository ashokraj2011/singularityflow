/** Actual source files and separately enrolled namespace stores, never manufactured source evidence. */
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {namespacePreparationFixture} from './namespace-preparation-fixture.mjs';
import {createNamespaceSourceEngine} from '../../src/engine-storage/namespace-source.mjs';
import {createNamespaceSourceRetentionEngine} from '../../src/engine-storage/namespace-source-retention.mjs';
import {createFilesystemSourceContentReader} from '../../src/sgos/filesystem-source-unit.mjs';

export async function namespaceSourceRetentionFixture(t,{backend='filesystem',configure=null}={}) {
  const f=await namespacePreparationFixture(t,{backend,code:true,configure});
  f.control.permissions.push('phase.source.retain');
  const privateFolder=path.join(f.sourceRoot,'singularity/work-items',f.inputs.workId,'inputs');await mkdir(privateFolder,{recursive:true});
  const localDocument='DEVICE-LOCAL-UPLOAD-CONTENT-MUST-NOT-BE-SHARED';
  await writeFile(path.join(privateFolder,'attachment.txt'),localDocument);
  await writeFile(path.join(f.sourceRoot,'gone.js'),'export const gone = true;');
  await writeFile(path.join(f.sourceRoot,'untouched.js'),'export const untouched = true;');
  const options={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,
    sources:[f.unit],localRecords:f.localRecords,localContent:f.localContent};
  await createNamespaceSourceEngine(options).run('source.bind',{operationId:'retain-baseline',workId:f.inputs.workId,
    expectedRevision:(await f.head()).record.version,repositories:['app'],reason:'Bind the actual baseline with selected local document metadata.'});
  await f.engine.run('phase.prepare');
  const binary=Buffer.from(Array.from({length:200_000},(_,index)=>(index*13)%251));
  await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 43;');await rm(path.join(f.sourceRoot,'gone.js'));
  await writeFile(path.join(f.sourceRoot,'binary.bin'),binary);await writeFile(path.join(f.sourceRoot,'empty.js'),'');
  await writeFile(path.join(privateFolder,'attachment.txt'),localDocument+'-later');
  const contentReader=await createFilesystemSourceContentReader({root:f.sourceRoot,id:'actual-content',source:f.unit.descriptor,maximumChunkBytes:8192});
  options.sourceReaders=[contentReader];
  const make=extra=>createNamespaceSourceRetentionEngine({...options,...extra});
  return {...f,binary,localDocument,privateFolder,contentReader,options,make,engine:make(),
    input:{operationId:'retain-source-one',workId:f.inputs.workId,phaseId:'intake'}};
}

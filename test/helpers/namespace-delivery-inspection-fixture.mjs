/** Actual code files, accepted byte archives and real pinned Node test runs; never seeded readiness. */
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespacePhaseCheckFixture} from './namespace-phase-check-fixture.mjs';
import {createFilesystemSourceContentReader} from '../../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceDeliveryInspectionEngine} from '../../src/engine-storage/namespace-delivery-inspection.mjs';
export async function namespaceDeliveryInspectionFixture(t,{backend='filesystem',failing=false,retainBaseline=true,configure=()=>{}}={}){
  const f=await namespacePhaseCheckFixture(t,{backend,configure:source=>{
    const phase=source.definition.phases.intake;phase.generation={producer:'governed-agent',task:'code'};phase.writeScope='source-and-artifact';phase.artifact.kind='implementation-summary';
    phase.qualityCommands[0].affectedRoots=['.'];phase.qualityCommands[0].ecosystem='node';
    source.definition.workTypes.simple.omits=source.definition.workTypes.simple.omits.filter(item=>item.responsibility!=='implement');configure(source);
  }});
  f.accessControl.permissions.push('phase.source.inspect','source.baseline.retain','phase.source.retain');
  const sourceReader=await createFilesystemSourceContentReader({root:f.root,id:'delivery-content',source:f.source.descriptor});
  const {localRecords,localContent,...shared}=f.options,options={...f.options,sourceReaders:[sourceReader]},
    engine=createNamespaceEngine({...shared,working:{records:localRecords,content:localContent},sourceReaders:[sourceReader],checks:f.checks});
  if(retainBaseline)await engine.run('source.baseline.retain',{operationId:'delivery-original',workId:f.inputs.workId,sourceBindingId:'source-for-checks'});
  await writeFile(path.join(f.root,'app.mjs'),'export const answer = 42;\n');
  await writeFile(path.join(f.root,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {answer} from './app.mjs';test('actual application result',()=>assert.equal(answer,"+(failing?'43':'42')+"));\n");
  const make=extra=>createNamespaceDeliveryInspectionEngine({...options,...extra});
  const retain=()=>engine.run('phase.source.retain',{operationId:'delivery-changes',workId:f.inputs.workId,phaseId:'intake'});
  const run=()=>engine.run('phase.checks.run',f.input);
  return {...f,options,make,engine,reader:make(),retain,run,sourceReader,inspect:()=>make().run('phase.delivery.inspect',{phaseId:'intake'})};
}

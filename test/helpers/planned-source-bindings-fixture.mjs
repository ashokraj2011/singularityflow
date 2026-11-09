/** Real pinned native plans and source bytes for the source-clause compatibility capture. */
import {codeDeliveryPreflightCases,codeDeliveryPreflightFixture} from './code-delivery-preflight-fixture.mjs';
import {buildRepositoryChangeSet} from '../../src/repository-change-set.mjs';
const claim={expectedPaths:['src/app.js'],tests:['test/app.test.js'],testDisposition:'applicable',deviation:null};
const shared='// @clause:SHARED:REQ-001 Returns the approved shared result.\nexport const value=42;\n';
export function plannedSourceBindingCases(){
  const rows=codeDeliveryPreflightCases().map(row=>({id:row.id,options:row.options,sourcePaths:['src/app.js']}));
  rows.push({id:'undelivered-tag',options:{changes:{}},sourcePaths:[]},
    {id:'deleted-delivered',options:{changes:{'src/app.js':null}},sourcePaths:['src/app.js']},
    {id:'missing-planning-owner',options:{},missingOwner:true,sourcePaths:['src/app.js']},
    {id:'changed-plan-pin',options:{},badPin:true,sourcePaths:['src/app.js']},
    {id:'oversized-source',options:{changes:{}},oversized:true,sourcePaths:['src/app.js']});
  for(const [id,baseline,source]of [
    ['shared-new','export const value=1;\n',shared],
    ['shared-carried',shared,shared.replace('42','43')],
    ['shared-unknown-carried',shared.replace('REQ-001','REQ-999'),shared.replace('REQ-001','REQ-999').replace('42','43')],
    ['shared-unknown-new','export const value=1;\n',shared.replace('REQ-001','REQ-999')],
    ['shared-new-and-carried',shared.replace('REQ-001','REQ-999'),shared.replace('REQ-001','REQ-999')+shared]
  ])rows.push({id,options:{claims:{'SHARED:REQ-001':claim},baseline:{'src/app.js':baseline},changes:{'src/app.js':source}},shared:true,sourcePaths:['src/app.js']});
  return rows;
}
export async function plannedSourceBindingFixture(row){
  const f=await codeDeliveryPreflightFixture(row.options);try{
    if(row.missingOwner)delete f.workflow.phases.planning;if(row.badPin)f.workflow.phases.planning.claimMaps.planned.sha256='0'.repeat(64);
    if(row.shared)f.workflow.resolution.spec.namespace='SHARED';if(row.oversized)await f.write('src/app.js','a'.repeat(16*1024*1024));
    const changeSet=await buildRepositoryChangeSet(f.root,{baseCommit:'HEAD'}),sourcePaths=row.sourcePaths,
      deletedSourcePaths=changeSet.entries.filter(entry=>entry.status==='deleted').map(entry=>entry.oldPath),
      input={config:f.config,workflow:f.workflow,phase:f.phase,sourcePaths,options:{deletedSourcePaths,changeSet}};
    return {...f,input};
  }catch(error){await f.close();throw error;}
}

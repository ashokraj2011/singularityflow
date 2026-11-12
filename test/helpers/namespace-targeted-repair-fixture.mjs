/** Two real planned behaviors make unrelated-file changes observable during targeted Code repair. */
import {writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture,releasePublish,releaseReport} from './namespace-release-fixture.mjs';
import {specificationText,planText} from './namespace-specification-fixture.mjs';
import {actualWitnessTest} from './namespace-test-witness-fixture.mjs';
export const unrelatedSource='// @clause:STORY-1:REQ-002 Preserves the independent identity behavior for every supplied value.\nexport const other=value=>value;\n';
export const targetedReport=(verdict='matched')=>releaseReport(verdict)+'| STORY-1:REQ-002 | matched |\n';
export async function namespaceTargetedRepairFixture(t,{backend='sqlite',budget=true,...extra}={}){
  const f=await namespaceReleaseFixture(t,{...extra,backend,
    specification:specificationText.replace('## Acceptance criteria','[STORY-1:REQ-002] Preserve the separate identity operation.\n\n## Acceptance criteria'),
    plan:planText+'| STORY-1:REQ-002 | `src/other.js` | `test/converter.test.js` |\n',
    afterPrepare:async(_f,_engine,roots)=>{for(const root of roots)await writeFile(path.join(root,'src/other.js'),unrelatedSource);},
    testSource:actualWitnessTest+"import {other} from '../src/other.js';\ntest('preserves the separate operation',()=>assert.equal(other(7),7));\n",
    configure:source=>{source.definition.phases.release.approval.rejectTo=['intake','build','release'];
      if(budget){source.definition.phases.build.repairBudget={maxAttempts:1,resetOnPhase:'intake'};
        source.definition.workTypes.simple.reworkLoops=[{from:'release',to:'build',maxAttempts:1,resetOnPhase:'intake'}];}
      extra.configure?.(source);}}).catch(error=>{t.diagnostic(JSON.stringify(error.details));throw error;});
  const access={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.review','phase.reject','decision.plan','plan.correction.context','plan.correction.record']})},reviewer=f.make({access});
  await f.write('release',targetedReport('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.engine.run('phase.submit',{phaseId:'release'});
  const {manifest}=await reviewer.run('phase.review',{phaseId:'release'}),request={phaseId:'release',target:'build',reason:'Repair the exact approved converter clause while preserving the separately planned identity behavior.',
    confirm:manifest.reviewBinding.packetSha256,clauseIds:['STORY-1:REQ-001']};
  async function begin({beforeSourceEdit=null}={}){f.control.agentId='analyst';await f.write('build','# Targeted converter repair\n\n## Agent brief\n\nPreserve the approved identity operation and execute the converter boundary regression.\n');
    if(beforeSourceEdit)await beforeSourceEdit();
    const file=path.join(f.root,'test/converter.test.js');await writeFile(file,(await readFile(file,'utf8'))+"\ntest('converts the next approved boundary',()=>assert.equal(convert(256),'100'));\n");}
  return {...f,reviewer,reviewerAccess:access,request,begin};
}

/** Specification and plan publication through real enrollment, creation and human approvals. */
import {namespacePreparationFixture} from './namespace-preparation-fixture.mjs';
import {createNamespacePublicationEngine} from '../../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../../src/engine-storage/namespace-submission.mjs';
import {createNamespaceApprovalEngine} from '../../src/engine-storage/namespace-approval.mjs';
import {createNamespaceLifecycleObserver} from '../../src/engine-storage/namespace-lifecycle-reader.mjs';
export const specificationText='# Specification\n\n## Requirements\n\n[STORY-1:REQ-001] Convert an integer into hexadecimal.\n\n## Acceptance criteria\n\n[STORY-1:AC-001] Given 255, conversion returns FF.\n';
export const planText='# Delivery plan\n\n## Agent brief\n\nImplement the approved converter and its boundary regressions.\n\n## Planned changes\n\n'
  +'| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n'
  +'| STORY-1:REQ-001 | `src/converter.js` | `test/converter.test.js` |\n'
  +'| STORY-1:AC-001 | `src/converter.js` | `test/converter.test.js` |\n';
const independent={name:'Independent reviewer',email:'independent@example.test',login:null};

export async function namespaceSpecificationFixture(t,{backend='filesystem',configure=()=>{}}={}) {
  const f=await namespacePreparationFixture(t,{backend,configure:source=>{
    source.definition.spec={mode:'enforce',namespace:'STORY-1',coverage:'enforce',acceptance:'presence'};
    const intake=source.definition.phases.intake;
    intake.artifact.kind='requirements';intake.specificationQuality={mode:'off'};
    intake.clarification={mode:'off',markers:{mode:'off'}};intake.approval.allowSelfApproval=false;
    source.definition.approvalAuthorities.reviewers.members.push({email:independent.email});
    source.definition.phases.design={label:'Design',artifact:{path:'artifacts/design/plan.md',kind:'implementation-plan'},defaultTemplate:'intake.md',
      specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},inputs:[{phase:'intake'}],
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['design'],allowSelfApproval:false}};
    source.definition.phases.build={label:'Build',artifact:{path:'artifacts/build/summary.md',kind:'implementation-summary'},defaultTemplate:'intake.md',
      generation:{producer:'governed-agent',task:'code'},writeScope:'source-and-artifact',inputs:[{phase:'design'}],
      specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['design'],allowSelfApproval:false},
      qualityCommands:[{id:'node-tests',argv:['node','--test'],kind:'test',modelPolicy:'never',affectedRoots:['.'],ecosystem:'node',result:{adapter:'node-tap',path:'results/tests.tap'}}]};
    source.definition.workTypes.simple={label:'Converter delivery',phases:['intake','design','build'],
      plannedClaims:{mode:'required',clausePhases:['intake'],owners:{build:'design'}}};
    source.agents[0].phases=['intake','design','build'];source.agents[0].defaultFor=['intake','design','build'];
    configure(source);
  }});
  f.control.permissions.push('phase.publish','phase.submit','phase.approve');
  const common={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};
  const publish=extra=>createNamespacePublicationEngine({...common,localRecords:f.localRecords,localContent:f.localContent,...extra});
  const reviewer=createNamespaceApprovalEngine({...common,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',
    actorKind:'human',identity:independent,agentId:null,permissions:['phase.approve']})}});
  const capture=async()=>(await createNamespaceLifecycleObserver(common).capture()).snapshot;
  const json=async reference=>JSON.parse(Buffer.from((await f.content.read(f.scope,reference)).data));
  let edits=0;
  async function author(phaseId,text) {
    await f.engine.run('phase.prepare',{phaseId});const draft=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:'author-spec-'+(++edits),workId:f.inputs.workId,phaseId,
      expectedRevision:draft.manifest.draft.revision,content:await f.upload(text),reason:'Complete the actual approved-intent contract.'});
    return publish().run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'});
  }
  async function approve(phaseId) {
    await createNamespaceSubmissionEngine(common).run('phase.submit',{phaseId});
    const {manifest}=await reviewer.run('phase.review',{phaseId}),binding=manifest.reviewBinding;
    return reviewer.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  }
  return {...f,common,publish,reviewer,capture,json,author,approve};
}

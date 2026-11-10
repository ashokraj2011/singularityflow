/** Frozen-value cases shared by the independent native capture and portable-rule tests. */
const W='PLAN-VALUES',A=W+':AC-001',B=W+':AC-002',C=W+':AC-003',at='2026-10-12T01:00:00.000Z';
export function planCorrectionValueCases(){return [
  {name:'replace-location',operations:[{op:'replace-location',clauseId:A,from:'src/old.mjs',to:'src/value.mjs'}]},
  {name:'add-row',operations:[{op:'add-row',clauseId:C,expectedPaths:['src/format.mjs'],tests:['test/format.test.mjs'],fulfillment:'new'}]},
  {name:'set-test-only',operations:[{op:'set-fulfillment',clauseId:A,fulfillment:'test-only'}]},
  {name:'add-test',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}]},
  {name:'add-supporting-test',stated:true,operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}]},
  {name:'replace-test',operations:[{op:'replace-test',clauseId:A,from:'test/value.test.mjs',to:'test/renamed.test.mjs'}]},
  {name:'replace-stated-test',stated:true,operations:[{op:'replace-test',clauseId:A,from:'test/value.test.mjs',to:'test/renamed.test.mjs'}]},
  {name:'remove-extra-test',extraTest:true,operations:[{op:'remove-test',clauseId:A,test:'test/extra.test.mjs'}]},
  {name:'remove-extra-location',extraPath:true,operations:[{op:'remove-location',clauseId:A,path:'src/extra.mjs'}]},
  {name:'sequence',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'},{op:'replace-location',clauseId:A,from:'src/old.mjs',to:'src/value.mjs'}]},
  {name:'same-fulfillment',operations:[{op:'set-fulfillment',clauseId:A,fulfillment:'modified'}]},
  {name:'unknown-fulfillment',operations:[{op:'set-fulfillment',clauseId:A,fulfillment:'rewritten'}]},
  {name:'invalid-fulfillment',operations:[{op:'set-fulfillment',clauseId:A,fulfillment:'New Value'}]},
  {name:'unknown-clause',operations:[{op:'add-test',clauseId:W+':AC-999',test:'test/new.test.mjs'}]},
  {name:'missing-row',operations:[{op:'add-test',clauseId:C,test:'test/new.test.mjs'}]},
  {name:'duplicate-row',operations:[{op:'add-row',clauseId:A,tests:['test/new.test.mjs']}]},
  {name:'empty-row',operations:[{op:'add-row',clauseId:C}]},
  {name:'duplicate-test',operations:[{op:'add-test',clauseId:A,test:'test/value.test.mjs'}]},
  {name:'remove-only-test',operations:[{op:'remove-test',clauseId:A,test:'test/value.test.mjs'}]},
  {name:'remove-stated-test',stated:true,extraTest:true,operations:[{op:'remove-test',clauseId:A,test:'test/value.test.mjs'}]},
  {name:'replace-missing-test',operations:[{op:'replace-test',clauseId:A,from:'test/missing.test.mjs',to:'test/new.test.mjs'}]},
  {name:'replace-to-existing-test',extraTest:true,operations:[{op:'replace-test',clauseId:A,from:'test/value.test.mjs',to:'test/extra.test.mjs'}]},
  {name:'remove-only-location',operations:[{op:'remove-location',clauseId:A,path:'src/old.mjs'}]},
  {name:'remove-missing-location',operations:[{op:'remove-location',clauseId:A,path:'src/missing.mjs'}]},
  {name:'replace-to-existing-location',extraPath:true,operations:[{op:'replace-location',clauseId:A,from:'src/old.mjs',to:'src/extra.mjs'}]},
  ...['../escape','/absolute','C:/absolute','bad\\path','test/*','test/','test//value','test/./value'].map(path=>({name:'path:'+path,operations:[{op:'add-test',clauseId:A,test:path}]})),
  {name:'empty-operations',operations:[]},{name:'unknown-operation',operations:[{op:'invent',clauseId:A}]},
  {name:'short-reason',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}],reason:'short'},
  {name:'invalid-authorization',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}],authorizationId:'not-a-uuid'},
  {name:'corrupt-row-digest',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}],tamper:'digest'},
  {name:'corrupt-authority',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}],tamper:'authority'},
  {name:'wrong-owner-map',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}],tamper:'map'},
  {name:'later-plan',operations:[{op:'add-test',clauseId:A,test:'test/edge.test.mjs'}],later:true},
  {name:'evidence-visual',evidence:'visual'},{name:'evidence-inspection',evidence:'inspection'},
  {name:'evidence-wrong-authority',evidence:'visual',tamper:'authority'},
  {name:'evidence-wrong-row',evidence:'visual',tamper:'digest'},
  {name:'evidence-outside-story',evidence:'visual',tamper:'path'},
  {name:'evidence-waives-tests',evidence:'visual',tamper:'waiver'},
  {name:'evidence-unknown-review',evidence:'visual',tamper:'review'},
  {name:'evidence-later-plan',evidence:'visual',later:true}
];}
export function planCorrectionValueOutcome(api,input){
  const record={schemaVersion:2,kind:'planned',workId:W,phase:'planning',generation:1,recordedAt:at,claims:{
    [A]:{expectedPaths:['src/old.mjs',...(input.extraPath?['src/extra.mjs']:[])],tests:['test/value.test.mjs',...(input.extraTest?['test/extra.test.mjs']:[])],
      testDisposition:'applicable',testReason:null,deviation:null,fulfillment:'modified'},
    [B]:{expectedPaths:[],tests:['test/only.test.mjs'],testDisposition:'applicable',testReason:null,deviation:null,fulfillment:'test-only'}}};
  if(input.stated)record.verificationContracts=[{clauseId:A,combination:'all',slots:[{slot:'primary',method:'test',role:'primary',witness:{path:'test/value.test.mjs'},requiredAssurance:null}]}];
  const workflow={workItem:{id:W},status:'in_progress',currentPhase:'code',phaseOrder:['planning','code'],phases:{
    planning:{id:'planning',status:'approved',generation:1,approvalPolicy:{authorities:['reviewers']},claimMaps:{planned:{path:'plan.json',sha256:api.recordSha256(record),generation:1}}},
    code:{id:'code',status:'in_progress',generation:0}}};
  let decision=null;
  try{
    if(input.evidence){const path='stories/'+W+'/evidence/screen.png';decision={id:'PEA-'+'a'.repeat(24),kind:'evidence-contract-correction',ownerPhase:'planning',ownerGeneration:1,
      ownerMapSha256:api.recordSha256(record),clauseId:A,previousClaimSha256:api.recordSha256(record.claims[A]),path,method:input.evidence,
      reason:'The approved evidence obligation needs its exact retained inspection contract.',actor:'reviewer@example.test',authorityGroup:'reviewers',authorizationId:'authorization-1',
      reviewAssurance:'live-terminal-exact-evidence-review',at,recordPath:'stories/'+W+'/appeals/evidence/PEA-'+'a'.repeat(24)+'.json',
      reviewedFile:{sha256:'b'.repeat(64),size:123},testsWaived:false,phaseApproved:false};workflow.planAmendments=[decision];
    }else decision=api.recordPlanRowCorrection(workflow,{ownerRecord:record,ownerMapSha256:api.recordSha256(record),operations:input.operations,activeClauseIds:[A,B,C],
      normalizeRow:(id,raw)=>api.normalizeRow(id,raw,[A,B,C]),reason:input.reason??'The exact approved delivery needs this corrected plan row.',actor:'reviewer@example.test',authorityGroup:'reviewers',
      authorizationId:input.authorizationId??'7b0c5a52-2f1e-4f7e-9a51-0c6d9f1b2a33',at});
    if(input.tamper==='digest'){if(input.evidence)decision.previousClaimSha256='0'.repeat(64);else decision.operations[0].previousClaimSha256='0'.repeat(64);}
    if(input.tamper==='authority')decision.authorityGroup='other';if(input.tamper==='map')decision.ownerMapSha256='0'.repeat(64);
    if(input.tamper==='path')decision.path='stories/OTHER/evidence/screen.png';if(input.tamper==='waiver')decision.testsWaived=true;if(input.tamper==='review')decision.reviewAssurance='invented';
    const planned=input.later?{...record,generation:2}:record,result=api.applyPlanCorrections(planned,workflow,{evidenceRoot:'stories/'+W+'/evidence'});
    return {status:'returned',decision,result,sha256:api.recordSha256(result),rows:api.planRowCorrections(workflow),authorities:api.planCorrectionAuthorities(workflow,'planning')};
  }catch(error){return {status:'thrown',error:{name:error.name,message:error.message,code:error.code??null,details:error.details??null}};}
}

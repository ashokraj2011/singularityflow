/** Value-only cases: these metadata fixtures are not execution, image or human-authority receipts. */
const at='2026-11-03T10:00:00.000Z',actor={name:'Example reviewer',email:'review@example.test'},subject={kind:'story-phase',workId:'review-example',phaseId:'delivery',generation:1};
function failure(error){return {name:error.name,code:error.code??null,message:error.message,details:error.details??null,
  ...(error.cause?{cause:{name:error.cause.name,code:error.cause.code??null,message:error.cause.message}}:{})};}
/** Preserve native in-memory undefined fields in the JSON oracle rather than dropping them. */
export function applicationReviewValueCapture(api){
  const encode=value=>value===undefined?{$undefined:true}:Array.isArray(value)?value.map(encode):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)])):value;
  return encode(applicationReviewValueCases(api));
}
export function applicationReviewValueCases(api){
  const results=[],capture=(id,work)=>{try{results.push({id,value:work()});}catch(error){results.push({id,error:failure(error)});}};
  function fixture(surface='backend'){
    const policy=api.normalizeApplicationReview({mode:'required',surface}),session=api.newReviewSession({id:'ARA-0123456789abcdef01234567',subject,policy}),
      target={id:'target-1',subject,assurance:'host-bound',applicability:api.reviewApplicability(policy,[]),policyDigest:api.reviewDigest(policy),
        plan:{digest:'plan-1',items:[{id:'criterion-1',dimension:'functional',text:'The accepted result remains observable.'}]},
        snapshot:{digest:'snapshot-1'},results:{digest:'results-1',packet:'packet-1',ready:true,attempts:[]}},
      append=(type,payload={},actionId='action-'+(session.revision+1))=>api.appendReviewEvent(session,{actionId,expectedRevision:session.revision,type,payload,actor,at});
    append('target-ready',{target});return {policy,session,target,append};
  }
  for(const surface of ['auto','web','backend','cli','library','artifact'])for(const paths of [[],['src/server.java'],['src/View.tsx'],['src/View.test.jsx']])
    capture('applicability:'+surface+':'+paths.join(','),()=>api.reviewApplicability(api.normalizeApplicationReview({surface}),paths));
  capture('new-session',()=>api.newReviewSession({id:'review',subject,policy:api.normalizeApplicationReview({surface:'backend'})}));
  for(const policy of [null,{mode:'off'},{mode:'required'},{schemaVersion:2,mode:'required'}])capture('policy-read:'+JSON.stringify(policy),()=>api.applicationReviewPolicy({resolution:{applicationReview:policy}}));
  capture('required-presence-owner',()=>api.applicationReviewPolicy({resolution:{applicationReview:{mode:'required'},presence:{status:'required'}}}));
  capture('execution-run-refused',()=>api.reviewSubject({kind:'run'}));capture('missing-subject-refused',()=>api.reviewSubject({}));
  capture('exact-subject',()=>api.reviewSubject({workItem:{id:subject.workId},currentPhase:'delivery',phases:{delivery:{generation:2}}}));
  capture('initial-projection',()=>api.projectReview(fixture().session));
  capture('event-replay',()=>{const f=fixture(),request={actionId:'feedback-action',expectedRevision:1,type:'feedback-recorded',payload:{finding:{id:'f1',observed:'Result disappeared'}},actor,at};
    return {first:api.appendReviewEvent(f.session,request),second:api.appendReviewEvent(f.session,request),revision:f.session.revision};});
  capture('same-action-different-intent',()=>{const f=fixture();f.append('target-preparing',{},'duplicate-action');f.append('target-blocked',{},'duplicate-action');});
  capture('stale-event-revision',()=>api.appendReviewEvent(fixture().session,{actionId:'stale-action',expectedRevision:0,type:'target-preparing',actor,at}));
  capture('invalid-action-identity',()=>api.appendReviewEvent(fixture().session,{actionId:'x',expectedRevision:1,type:'target-preparing',actor,at}));
  capture('missing-actor',()=>api.appendReviewEvent(fixture().session,{actionId:'missing-actor',expectedRevision:1,type:'target-preparing',actor:null,at}));
  capture('invalid-event-time',()=>api.appendReviewEvent(fixture().session,{actionId:'invalid-time',expectedRevision:1,type:'target-preparing',actor,at:'unknown'}));
  capture('event-limit',()=>{const f=fixture();f.session.events=Array(2000).fill(f.session.events[0]);f.session.revision=2000;f.append('target-preparing');});
  capture('tampered-event',()=>{const f=fixture();f.session.events[0].payload.target.id='different';return api.validateReviewSession(f.session);});
  capture('changed-policy',()=>{const f=fixture();f.session.policy.capture.maximumPages++;return api.validateReviewSession(f.session);});
  capture('future-session',()=>api.validateReviewSession({...fixture().session,schemaVersion:2}));
  capture('unversioned-session',()=>{const {schemaVersion,...session}=fixture().session;return api.validateReviewSession(session);});
  capture('invalid-session-version',()=>api.validateReviewSession({...fixture().session,schemaVersion:'future'}));
  capture('null-session',()=>api.validateReviewSession(null));
  capture('text-session',()=>api.validateReviewSession(JSON.stringify(fixture().session)));
  capture('uncloneable-session',()=>api.validateReviewSession({...fixture().session,unexpected:()=>{}}));
  capture('repair-and-actual-recheck-projection',()=>{const f=fixture();
    f.append('feedback-recorded',{finding:{id:'f1',observed:'Result disappeared',repairRequested:true}});
    f.append('repair-prepared',{attempt:{id:'attempt-1',findingId:'f1',rootFindingId:'f1'}});
    f.append('repair-observed',{attemptId:'attempt-1',result:{testsPassed:true,targetId:'target-2'}});
    const before=api.projectReview(f.session);f.append('finding-rechecked',{findingId:'f1',result:'fixed',targetId:'target-2'});
    return {before,after:api.projectReview(f.session)};});
  for(const type of ['target-preparing','target-blocked','capture-started','capture-blocked','acceptance-blocked','review-stale','review-deferred','review-cancelled'])
    capture('state:'+type,()=>{const f=fixture();f.append(type,{code:'observed',message:'The retained observation remains visible.'});return api.projectReview(f.session);});
  capture('unknown-event',()=>{const f=fixture();f.append('invented-success');return api.projectReview(f.session);});
  capture('lineage-cycle',()=>api.findingRoot([{id:'a',duplicateOf:'b'},{id:'b',duplicateOf:'a'}],'a'));
  capture('lineage-missing',()=>api.findingRoot([{id:'a',duplicateOf:'missing'}],'a'));
  capture('shared-repair-budget',()=>api.findingRepairAttempts({findings:[{id:'a',duplicateOf:'b'},{id:'b'}],repairAttempts:[{id:'one',rootFindingId:'a'},{id:'two',rootFindingId:'b'}]},'a'));
  const confirmation={targetCurrent:true,testsReady:true,dimensions:['functional'],coverage:['criterion-1']};
  for(const change of [{},{targetCurrent:false},{testsReady:false},{dimensions:['visual']},{coverage:[]}])capture('confirmation:'+JSON.stringify(change),()=>{
    const result=api.assertCanConfirm(api.projectReview(fixture().session),{...confirmation,...change});return result??null;});
  capture('open-finding-blocks-confirmation',()=>{const f=fixture();f.append('feedback-recorded',{finding:{id:'f1'}});api.assertCanConfirm(api.projectReview(f.session),confirmation);});
  for(const found of [0,1,4])for(const maximumPages of [1,10])capture('report:'+found+':'+maximumPages,()=>api.reviewReportPages({attempts:[{
    attemptId:'attempt-1',commandId:'unit',status:'passed',tests:{discovered:found,passed:found,failed:0,skipped:0},
    occurrences:[{name:'actual case',outcome:'passed',durationMs:3},{name:'failed case',outcome:'failed',durationMs:4}],caseMessages:[null,'Observed failure.']}]},
    {casesPerPage:1,maximumPages}));
  function captureFixture(){const f=fixture(),report=api.reviewReportPages(f.target.results,f.policy.capture);
    f.append('review-confirmed',{dimensions:['functional'],coverage:['criterion-1'],targetId:f.target.id,
      hostAction:{id:'human-action'},capturePlan:{reportDigest:api.reviewDigest(report),applicationUi:false}});
    const view=api.projectReview(f.session),body={captureItem:'summary',confirmation:view.confirmation.id,trigger:'human-action',targetId:f.target.id,
      captureKind:'test-results',cases:[],sourceSnapshot:f.target.snapshot.digest,resultsDigest:f.target.results.digest,subject,
      status:'captured',capturedAt:'2026-11-03T10:00:01.000Z',sha256:'sha256:'+'a'.repeat(64),artifactRef:{digest:'sha256:'+'a'.repeat(64)},bytes:128,image:{format:'png',width:1280,height:800}};
    return {...f,view,receipt:{id:api.reviewDigest(body),...body}};}
  capture('capture-set-shape',()=>{const f=captureFixture();return api.validateReviewCaptureSet(f.view,[f.receipt],f.policy);});
  capture('capture-set-missing',()=>{const f=captureFixture();return api.validateReviewCaptureSet(f.view,[],f.policy);});
  for(const change of [{targetId:'other'},{capturedAt:'2026-11-03T09:00:00.000Z'},{cases:['unrelated']},{captureKind:'application-ui'},{image:{format:'jpeg',width:1280,height:800}}])
    capture('capture-set-invalid:'+JSON.stringify(change),()=>{const f=captureFixture(),{id,...body}={...f.receipt,...change};return api.validateReviewCaptureSet(f.view,[{id:api.reviewDigest(body),...body}],f.policy);});
  capture('capture-set-byte-limit',()=>{const f=captureFixture();return api.validateReviewCaptureSet(f.view,[f.receipt],{...f.policy,capture:{...f.policy.capture,maximumBytes:1}});});
  for(const facts of [{targetCurrent:false,evidenceAvailable:true},{targetCurrent:true,evidenceAvailable:false},{targetCurrent:true,evidenceAvailable:true}])
    capture('completion:'+JSON.stringify(facts),()=>{const f=captureFixture();f.append('capture-admitted',{receipts:[f.receipt]});
      f.append('acceptance-finalized',{decisions:[{dimension:'functional'}]});return api.reviewCompletion(api.projectReview(f.session),facts);});
  return results;
}

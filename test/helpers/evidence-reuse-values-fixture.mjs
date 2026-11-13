/** Calls shared by the original native capture and the current compatibility adapter. Metadata fixtures only; these values are not retained execution evidence. */
export function evidenceReuseValueCases(api){
  const workflow=()=>({status:'in_progress',workItem:{id:'example'},phaseOrder:['build','assess'],phases:{build:{id:'build',status:'approved',generation:1},assess:{id:'assess',status:'in_progress',generation:0}}}),
    candidate={attempt:{id:'TA-'+'a'.repeat(20),sha256:'b'.repeat(64),path:'attempt.json',phase:'build',generation:1,commandId:'unit',status:'passed',
      tests:{discovered:1,passed:1,failed:0,skipped:0},completedAt:'2026-10-01T12:00:00.000Z'},source:{commit:'c'.repeat(40),treeSha256:'sha256:'+'d'.repeat(64),testInputSha256:null},clauses:['EXAMPLE:AC-001']},
    base={phaseId:'assess',candidate,reason:'The original passing result applies to the unchanged source.',actor:'reviewer',authorityGroup:'reviewers',at:'2026-10-01T12:00:00.000Z'},cases=[];
  const add=(name,call)=>{try{cases.push({name,ok:true,value:call()});}catch(error){cases.push({name,ok:false,error:{code:error.code??null,message:error.message,details:error.details??null}});}};
  for(const [name,reason]of [['empty',''],['short','reason'],['lower-bound','a'.repeat(20)],['upper-bound','a'.repeat(1000)],['too-long','a'.repeat(1001)],['trimmed','  '+base.reason+'  '],['number',42]])
    add('reason-'+name,()=>api.recordEvidenceReuse(workflow(),{...base,reason}));
  for(const expires of [null,'2026-10-01','2026-10-02','2026-12-29','2026-12-30','2026-12-31','2026-01-01','invalid','2026-10-02T00:00:00Z','2026-11-31'])
    add('expiry-'+String(expires),()=>api.recordEvidenceReuse(workflow(),{...base,expires}));
  for(const [name,reason]of [['empty',''],['short','reason'],['lower-bound','a'.repeat(20)],['upper-bound','a'.repeat(1000)],['too-long','a'.repeat(1001)],['trimmed','  '+base.reason+'  ']])
    add('revoke-'+name,()=>{const value=workflow();api.recordEvidenceReuse(value,base);return api.recordEvidenceReuseRevocation(value,{reuseId:'ERU-001',reason,actor:'reviewer',authorityGroup:'reviewers',at:base.at});});
  add('unknown-revoke',()=>api.recordEvidenceReuseRevocation(workflow(),{reuseId:'ERU-999',reason:base.reason,actor:'reviewer',authorityGroup:'reviewers',at:base.at}));
  return cases;
}

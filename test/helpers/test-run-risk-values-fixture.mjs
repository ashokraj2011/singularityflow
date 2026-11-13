/** Metadata/value observations only. These records do not authenticate a reviewer or establish execution. */
export function testRunRiskValueCases(api){
  const cases=[],at='2026-11-13T12:00:00.000Z',digest='a'.repeat(64),story=()=>({testRunRisks:[]}),
    run=(extra={})=>({attemptId:'TA-'+'b'.repeat(20),commandId:'unit',argvSha256:digest,status:'failed',exitCode:1,
      tests:{discovered:2,passed:1,failed:1,skipped:0},cause:{category:'environment',class:'service-unreachable',basis:'tests',signal:'ECONNREFUSED',failedTests:1},...extra}),
    base={phaseId:'assess',attempt:run(),cause:'The integration service is unavailable on this device.',reason:'The independent deployment pipeline exercises this service before release.',
      expires:'2026-11-20',actor:'reviewer',authorityGroup:'reviewers',at},
    add=(name,call)=>{try{cases.push({name,ok:true,value:call()});}catch(error){cases.push({name,ok:false,error:{code:error.code??null,message:error.message,details:error.details??null}});}};
  for(const [name,attempt]of [['missing',null],['passed',run({status:'passed'})],['not-run',run({status:'not-run'})],['environment',run()],
    ['no-tests',run({tests:null})],['unknown',run({cause:null})],['timeout',run({timedOut:true,cause:null})],
    ['code',run({cause:{class:'assertion-failure',category:'code',basis:'tests',signal:'assertion'}})],
    ['syntax',run({cause:{class:'syntax-error',category:'code',basis:'process',signal:'SyntaxError',file:'src/value.js'}})]]){
    add('eligibility-'+name,()=>api.testRunRiskIneligibility(attempt));
    add('record-'+name,()=>{const workflow=story(),record=api.recordTestRunRisk(workflow,{...base,attempt});return {record,workflow};});
    add('count-'+name,()=>({executed:api.testsExecuted(attempt),none:api.noTestExecuted(attempt)}));
  }
  for(const [name,options]of [['digest',{attempt:null,commandId:'unit',argvSha256:digest,causeClass:'service-unreachable'}],
    ['digest-no-class',{attempt:null,commandId:'unit',argvSha256:digest}],['digest-code',{attempt:null,commandId:'unit',argvSha256:digest,causeClass:'assertion-failure'}],
    ['digest-invalid',{attempt:null,commandId:'unit',argvSha256:'sha256:'+digest,causeClass:'service-unreachable'}],
    ['cause-mismatch',{causeClass:'registry-unreachable'}],['cause-short',{cause:'short'}],['cause-long',{cause:'x'.repeat(301)}],
    ['reason-short',{reason:'short'}],['reason-long',{reason:'x'.repeat(1001)}],['trimmed',{reason:'  '+base.reason+'  ',cause:'  '+base.cause+'  '}],
    ...['2026-11-12','2026-11-13','2027-02-10','2027-02-11','2027-05-01','2026-11-31','invalid',null].map(expires=>['expiry-'+expires,{expires}])])
    add(name,()=>{const workflow=story(),record=api.recordTestRunRisk(workflow,{...base,...options});return {record,workflow};});
  add('sequence-preserves-revocation',()=>{const workflow=story();api.recordTestRunRisk(workflow,base);workflow.testRunRisks.push({revokes:'TRR-001'});
    return {record:api.recordTestRunRisk(workflow,base),workflow};});
  return cases;
}

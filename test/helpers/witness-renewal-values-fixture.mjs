/** Value observations only; these fixtures neither approve evidence nor establish a human exception. */
export function witnessRenewalValueCases(api){
  const cases=[],mappingSha256='sha256:'+'a'.repeat(64),at='2026-11-13T12:00:00.000Z',
    story=()=>({workItem:{id:'example'},phases:{code:{id:'code',generation:2,status:'approved',approvals:[
      {decision:'approved',generation:1,witnessMappings:[{mappingSha256,decision:'exception',expiresAt:'2026-11-01T23:59:59.999Z',clauseId:'EXAMPLE:AC-001'}]},
      {decision:'approved',generation:2,witnessMappings:[{mappingSha256,decision:'exception',expiresAt:'2026-11-10T23:59:59.999Z',clauseId:'EXAMPLE:AC-001'}]}]}},witnessExceptionRenewals:[]}),
    base={phaseId:'code',mappingSha256,expires:'2026-12-01',reason:'The independent review accepts only the original adequacy exception.',actor:'reviewer',authorityGroup:'reviewers',at},
    add=(name,call)=>{try{cases.push({name,ok:true,value:call()});}catch(error){cases.push({name,ok:false,error:{code:error.code??null,message:error.message,details:error.details??null}});}};
  for(const [name,change]of [['current',()=>{}],['other-generation',workflow=>workflow.phases.code.generation=3],
    ['invalidated',workflow=>workflow.phases.code.approvals[1].invalidatedAt=at],['rejected',workflow=>workflow.phases.code.approvals[1].decision='rejected'],
    ['confirmed',workflow=>workflow.phases.code.approvals[1].witnessMappings[0].decision='confirmed'],['missing-mappings',workflow=>delete workflow.phases.code.approvals[1].witnessMappings]]){
    add('select-'+name,()=>{const workflow=story();change(workflow);return api.witnessException(workflow,'code',mappingSha256);});
    add('record-'+name,()=>{const workflow=story();change(workflow);return {record:api.recordWitnessExceptionRenewal(workflow,base),workflow};});
  }
  for(const [name,extra]of [['unknown-phase',{phaseId:'other'}],['unknown-mapping',{mappingSha256:'sha256:'+'b'.repeat(64)}],
    ...['2026-11-12','2026-11-13','2026-12-01T10:30:00.000Z','2026-11-31','invalid',null].map(expires=>['expiry-'+expires,{expires}]),
    ...['','short','a'.repeat(10),'a'.repeat(1000),'a'.repeat(1001),'  retained exception reason  '].map(reason=>['reason-'+String(reason).slice(0,12)+'-'+reason.length,{reason}])])
    add(name,()=>{const workflow=story();return {record:api.recordWitnessExceptionRenewal(workflow,{...base,...extra}),workflow};});
  add('renew-twice',()=>{const workflow=story();api.recordWitnessExceptionRenewal(workflow,base);
    return {record:api.recordWitnessExceptionRenewal(workflow,{...base,expires:'2026-12-15'}),workflow};});
  add('other-generation-renewal',()=>{const workflow=story();workflow.witnessExceptionRenewals.push({phase:'code',generation:1,mappingSha256,expiresAt:'2027-01-01T12:00:00Z'});
    return api.recordWitnessExceptionRenewal(workflow,base);});
  add('query-latest',()=>{const workflow=story();api.recordWitnessExceptionRenewal(workflow,base);
    return api.renewedWitnessExpiry(workflow,'code',2,mappingSha256);});
  add('query-missing',()=>api.renewedWitnessExpiry(story(),'code',2,mappingSha256));
  return cases;
}

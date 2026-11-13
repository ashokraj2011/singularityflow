import {createTrpFixture} from '../test-recovery-policy.fixture.mjs';

/** Captured against the original native intake constructor before its extraction. */
export function baselineRiskValueCases(){
  const fixture=createTrpFixture(),at='2026-10-02T11:00:00.000Z',cases=[];
  const original=()=>({agreement:structuredClone(fixture.agreement),baseline:structuredClone(fixture.baseline),options:{
    authority:{policy:structuredClone(fixture.policy)},choices:{reason:'  Keep the existing legacy failure visible.  ',expiresAt:'2026-10-20T10:00:00Z',
      followUpOwner:'  legacy-team  ',remediationRef:'  issue-legacy-1  '},principal:'reviewer@example.test',planDigest:fixture.hash('reviewed-baseline-plan'),createdAt:at}});
  function add(name,change=()=>{}){const value=original();change(value);cases.push({name,...value});}
  add('exact original baseline');
  add('explicit compatible baseline',v=>v.baseline.dependencies.unshift({id:'baseline-compatibility',sha256:fixture.hash('protected-source-and-runtime')}));
  add('only compatible baseline',v=>v.baseline.dependencies=[{id:'baseline-compatibility',sha256:fixture.hash('protected-source-and-runtime')}]);
  add('empty dependency inventory',v=>v.baseline.dependencies=[]);
  add('explicit transitions',v=>v.options.transitions=['publish','submit','approve']);
  add('empty transitions',v=>v.options.transitions=[]);
  add('explicit validation epoch',v=>v.options.validationEpoch=7);
  add('distinct original principal',v=>v.options.principal='second-reviewer@example.test');
  add('distinct exact review digest',v=>v.options.planDigest=fixture.hash('second-plan'));
  add('another phase and repository',v=>Object.assign(v.baseline.subject,{phaseId:'custom-check',repositoryId:'library'}));
  add('retained source generation',v=>v.baseline.subject.generation=7);
  add('multiple failed cases',v=>{v.baseline.cases[1]={...v.baseline.cases[1],outcome:'failed',causeSha256:fixture.hash('second-cause')};v.baseline.counts={...v.baseline.counts,passed:0,failed:2};});
  add('failed case order preserved',v=>v.baseline.cases.reverse());
  add('all original failures repaired',v=>{v.baseline.cases[0]={...v.baseline.cases[0],outcome:'passed',causeSha256:null};v.baseline.counts={...v.baseline.counts,passed:2,failed:0};});
  add('bounded evidence age',v=>v.options.authority.policy.maxEvidenceAgeSeconds=60);
  add('exact timestamp representation',v=>v.options.createdAt='2026-10-02T11:00:00Z');
  add('explicit reason whitespace',v=>v.options.choices.reason='\n  exact review\t\n');
  add('missing baseline dependencies',v=>delete v.baseline.dependencies);
  add('missing policy',v=>delete v.options.authority.policy);
  add('non-string reason',v=>v.options.choices.reason=13);
  add('non-string follow-up',v=>v.options.choices.followUpOwner=null);
  add('invalid principal',v=>v.options.principal='');
  add('invalid validation epoch',v=>v.options.validationEpoch=-1);
  add('invalid review digest',v=>v.options.planDigest='not-a-digest');
  return cases;
}
export function observeBaselineRiskValue(build,row){
  try{return {value:build(structuredClone(row.agreement),structuredClone(row.baseline),structuredClone(row.options))};}
  catch(error){return {error:{name:error.name,message:error.message,code:error.code??null,details:error.details??null}};}
}

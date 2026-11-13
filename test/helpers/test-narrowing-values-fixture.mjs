/** Explicit value observations; native expectations are captured before extracting the rules. */
export function testNarrowingValueCases(){
  const at='2026-11-08T12:00:00.000Z',rows=[],add=(name,operation,...args)=>rows.push({name,operation,args}),
    base={filters:[],focused:[],baseline:5,baselineSkipped:0},filter={option:'-t',value:'selected',source:'argv'},focus={path:'test/a.test.js',line:3,name:'one'},
    narrowing={reasons:['filter','skipped','below-baseline'],filters:[filter],focused:[],skipped:1,discovered:3,baseline:5,shortfall:2},
    attempt={attemptId:'TA-original',commandId:'unit',status:'passed',pin:{sha256:'sha256:'+'a'.repeat(64)},narrowing},
    input={phaseId:'code',attempt,reason:'The original reviewers accept this bounded test selection.',actor:'reviewer',authorityGroup:'reviewers',at},
    decision={id:'TNR-001',phase:'code',commandId:'unit',pinSha256:attempt.pin.sha256,narrowing,reason:input.reason,expiresAt:'2026-12-01T23:59:59.999Z',at};
  for(const baseline of [null,0,5,12])for(const discovered of [null,0,5,8])add('counts '+baseline+' '+discovered,'observedNarrowing',{...base,baseline},{discovered,skipped:0});
  for(const [name,facts,tests]of [
    ['new filter',{...base,filters:[filter]},{discovered:5,skipped:0}],['new focus',{...base,focused:[focus]},{discovered:5,skipped:0}],
    ['standing filters',{...base,standing:{filters:[filter],focused:[focus]}},{discovered:5,skipped:0}],
    ['standing skip',{...base,baselineSkipped:2},{discovered:5,skipped:2}],['new skips',{...base,baselineSkipped:2},{discovered:5,skipped:3}],
    ['new skip markers',{...base,baselineSkipped:null,addedSkips:[{path:'test/a.test.js',added:1}]},{discovered:5,skipped:1}],
    ['path observation',{...base,paths:[{source:'argv',operands:['test/a.test.js'],droppedCount:1}]},{discovered:5,skipped:0}],
    ['string counts',base,{discovered:'5',skipped:'2'}],['missing counts',null,null]
  ])add(name,'observedNarrowing',facts,tests);
  for(const [index,workflow]of [{},{testRecovery:{}},{resolution:{testRecovery:{enabled:true,enabledRiskCategories:['reduced-coverage']}}},
    {testRecovery:{},resolution:{testRecovery:{enabledRiskCategories:['reduced-coverage']}}},{resolution:{testRecovery:{enabled:true,enabledRiskCategories:['environment']}}}].entries())
    add('agreement '+index,'skippedByAgreement',workflow);
  add('all reasons','narrowingReasons',narrowing);add('skips accepted','narrowingReasons',narrowing,{skippedAccepted:true});
  add('no reasons','narrowingReasons',null);
  for(const [index,value]of [null,narrowing,{...narrowing,filters:[filter,filter],focused:[focus,focus]},
    {...narrowing,filters:[{...filter,source:'package.json#scripts.test'}]},
    {...narrowing,reasons:[],discovered:99,baseline:99}, {...narrowing,skipped:2}].entries())add('fingerprint '+index,'narrowingFingerprint',value);
  for(const [index,value]of [narrowing,{...narrowing,skipped:0,shortfall:0},{...narrowing,skipped:2},{...narrowing,shortfall:3},
    {...narrowing,filters:[{...filter,value:'different'}]}, {...narrowing,focused:[focus]},null].entries())
    for(const skippedAccepted of [false,true])add('coverage '+index+' '+skippedAccepted,'narrowingCovers',narrowing,value,{skippedAccepted});
  for(const [index,value]of [null,{...attempt,status:'failed'},{...attempt,status:'unavailable'},{...attempt,pin:null},{...attempt,narrowing:{reasons:[]}},attempt].entries())
    add('eligibility '+index,'testNarrowingIneligibility',value);
  add('record actual narrowing','recordTestNarrowing',{testNarrowings:[]},input);
  for(const [index,extra]of [{expires:'2026-12-01'},{expires:'2026-11-08'},{expires:'2026-11-07'},{expires:'invalid'},
    {expires:'2026-12-01T00:00:00Z'},{reason:'x'.repeat(19)},{reason:'x'.repeat(20)},{reason:'x'.repeat(1000)},
    {reason:'x'.repeat(1001)},{reason:'  A bounded human review accepts these exact selected tests.  '},
    {attempt:null},{attempt:{...attempt,status:'failed'}},{attempt:{...attempt,narrowing:{reasons:[]}}}].entries())
    add('record '+index,'recordTestNarrowing',{testNarrowings:[{...decision},{revokes:'TNR-older'}]},{...input,...extra});
  const revoke={narrowingId:'TNR-001',reason:'The full configured test coverage is required again.',actor:'reviewer',authorityGroup:'reviewers',at};
  add('revoke actual','recordTestNarrowingRevocation',{testNarrowings:[decision]},revoke);
  add('revoke unknown','recordTestNarrowingRevocation',{testNarrowings:[]},revoke);
  add('revoke twice','recordTestNarrowingRevocation',{testNarrowings:[decision,{revokes:decision.id}]},revoke);
  add('revoke reason invalid','recordTestNarrowingRevocation',{testNarrowings:[decision]},{...revoke,reason:'short'});
  for(const [index,expiry]of [null,'2026-12-01T00:00:00Z',at,'2026-11-01T00:00:00Z','invalid'].entries()){
    add('state '+index,'testNarrowingState',{testNarrowings:[decision]},{...decision,expiresAt:expiry},{at});
    add('revoked state '+index,'testNarrowingState',{testNarrowings:[decision,{revokes:decision.id}]},{...decision,expiresAt:expiry},{at});}
  add('decision binding','testNarrowingBinding',decision);
  return rows;
}
export function observeTestNarrowingValue(api,row){const args=structuredClone(row.args);
  try{const value=api[row.operation](...args);return {kind:'return',value,...(row.operation.startsWith('record')?{workflow:args[0]}:{})};}
  catch(error){return {kind:'throw',name:error.name,message:error.message,...(error.code?{code:error.code}:{}),...(error.details?{details:error.details}:{})};}}
export function admittedTestNarrowingValues(values){return {...values,
  recordTestNarrowingRevocation:(workflow,input)=>values.recordTestNarrowingRevocation(workflow,input,{records:workflow.testNarrowings??[]}),
  testNarrowingState:(workflow,decision,options)=>values.testNarrowingState(workflow.testNarrowings??[],decision,options)};}

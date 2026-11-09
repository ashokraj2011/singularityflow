/** Native claim-map inputs; no candidate/coverage decisions are implemented by this fixture. */
export const CLAIM_CAPTURE_TIME='2026-02-03T04:05:06.789Z';
const req='CLAIM:REQ-001',ac='CLAIM:AC-001';
const tests=['test/value.test.js'];
const source=['src/value.js'];
const planned={claims:{[req]:{expectedPaths:source,tests},[ac]:{expectedPaths:source,tests}}};
const table=(rows,optional='')=>'## Planned evidence\n| Clause | Expected paths | Planned tests'+optional+' |\n| --- | --- | ---'+optional.replace(/[^|]+/gu,' --- ')+' |\n'+rows.join('\n')+'\n';
const basicRows=[`| ${req} | \`src/value.js\` | \`test/value.test.js\` |`,`| ${ac} | \`src/value.js\` | \`test/value.test.js\` |`];
const options={clauseIds:[req,ac]};
export function specificationClaimCases() {
  const cases=[];const add=(name,operation,...args)=>cases.push({name,operation,args});
  const normalize=(name,value,overrides={})=>add(name,'normalizeClaimMap',value,{kind:'planned',...options,...overrides});
  normalize('ordinary',planned);
  normalize('empty',{});
  normalize('mixed-case',{claims:{'claim:req-001':{expectedPaths:['src/value.js','src/value.js'],tests:tests.slice().reverse()}}});
  normalize('duplicate-identity',{claims:{'CLAIM:REQ-001':{},'claim:req-001':{}}});
  normalize('unknown-clause',{claims:{'CLAIM:REQ-999':{}}});
  normalize('bad-kind',planned,{kind:'other'});
  normalize('bad-policy',planned,{policy:{mode:'other'}});
  normalize('null',null);
  normalize('array',[]);
  normalize('null-claims',{claims:null});
  normalize('bad-claims',{claims:[]});
  normalize('bad-row',{claims:{[req]:null}});
  for(const candidate of [['src/value.js',null],['../escape.js'],['src/../escape.js'],['/tmp/value.js'],['./src/value.js'],['src\\value.js'],['C:/value.js']])
    normalize('paths-'+JSON.stringify(candidate),{claims:{[req]:{expectedPaths:candidate,tests}}});
  normalize('path-count',{claims:{[req]:{expectedPaths:['src/a.js','src/b.js'],tests}}},{policy:{limits:{maxPathsPerClaim:1}}});
  normalize('bad-disposition',{claims:{[req]:{expectedPaths:source,testDisposition:'waived'}}});
  normalize('not-applicable',{claims:{[req]:{expectedPaths:source,tests:[],testDisposition:'not-applicable',testReason:'Exact visual inspection proves this requirement.'}}});
  normalize('not-applicable-with-tests',{claims:{[req]:{expectedPaths:source,tests,testDisposition:'not-applicable',testReason:'Exact visual inspection.'}}});
  normalize('not-applicable-without-reason',{claims:{[req]:{expectedPaths:source,tests:[],testDisposition:'not-applicable'}}});
  normalize('unexpected-reason',{claims:{[req]:{expectedPaths:source,tests,testReason:'This is not an exemption.'}}});
  normalize('non-test',{claims:{[ac]:{expectedPaths:['singularity/work-items/claim/evidence/screen.png'],tests:[],testDisposition:'non-test',verificationCriterion:ac}}});
  normalize('non-test-wrong-criterion',{claims:{[ac]:{expectedPaths:source,tests:[],testDisposition:'non-test',verificationCriterion:'CLAIM:AC-002'}}});
  normalize('unexpected-criterion',{claims:{[req]:{expectedPaths:source,tests,verificationCriterion:ac}}});
  for(const fulfillment of ['new','modified','existing','removed','test-only','document','configuration','evidence','other']) {
    const expectedPaths=fulfillment==='test-only'?[]:fulfillment==='configuration'?['package.json']:fulfillment==='document'?['docs/value.md']:fulfillment==='evidence'?['evidence/screen.png']:source;
    normalize('fulfillment-'+fulfillment,{claims:{[req]:{expectedPaths,tests,fulfillment,steps:['repair','implement','repair'],observableResult:'A real observable outcome.'}}});
    if(fulfillment!=='test-only')normalize('missing-path-'+fulfillment,{claims:{[req]:{expectedPaths:[],tests,fulfillment}}});
  }
  normalize('test-only-source',{claims:{[req]:{expectedPaths:source,tests,fulfillment:'test-only'}}});
  normalize('test-only-no-tests',{claims:{[req]:{expectedPaths:[],tests:[],fulfillment:'test-only'}}});
  normalize('bad-steps',{claims:{[req]:{expectedPaths:source,tests,steps:['Bad Step']}}});
  normalize('empty-observable',{claims:{[req]:{expectedPaths:source,tests,observableResult:' '}}});
  normalize('long-observable',{claims:{[req]:{expectedPaths:source,tests,observableResult:'x'.repeat(501)}}});
  normalize('supporting',{...planned,supportingFiles:['package.json'],supportingFileDetails:[{path:'package.json',class:'build-configuration',reason:'Adds the pinned test dependency.'}]});
  normalize('supporting-class-forged',{...planned,supportingFiles:['package.json'],supportingFileDetails:[{path:'package.json',class:'documentation',reason:'Adds the pinned test dependency.'}]});
  normalize('supporting-unlisted',{...planned,supportingFiles:['package.json'],supportingFileDetails:[{path:'README.md',class:'documentation',reason:'Documents the test command.'}]});
  normalize('supporting-missing-details',{...planned,supportingFiles:['package.json','README.md'],supportingFileDetails:[{path:'package.json',class:'build-configuration',reason:'Adds the pinned test dependency.'}]});
  normalize('bad-contract',{...planned,verificationContracts:[{clauseId:ac,combination:'all',slots:[]}]});
  normalize('byte-limit-after-clock',planned,{policy:{limits:{maxClaimBytes:100}}});
  normalize('unicode-byte-limit',{claims:{[req]:{expectedPaths:source,tests,deviation:'😀'.repeat(200)}}},{policy:{limits:{maxClaimBytes:1000}}});
  for(const verdict of ['matched','partial','missing','deviated','unplanned','other'])add('observed-'+verdict,'normalizeClaimMap',
    {claims:{[req]:{observedPaths:source,testResults:tests,commits:['A'.repeat(40),'b'.repeat(64),'A'.repeat(40)],verdict,deviation:'Actual limitation.'}}},{kind:'observed',...options});
  add('observed-no-source','normalizeClaimMap',{claims:{[req]:{testResults:tests,verdict:'matched'}}},{kind:'observed',...options});
  add('observed-ac-tests','normalizeClaimMap',{claims:{[ac]:{testResults:tests,verdict:'matched'}}},{kind:'observed',...options});
  for(const commits of [['short'],[1],null,'a'.repeat(40)])add('commits-'+JSON.stringify(commits),'normalizeClaimMap',
    {claims:{[req]:{observedPaths:source,testResults:tests,commits,verdict:'matched'}}},{kind:'observed',...options});
  for(const results of [tests,[],['test/other.test.js']])add('observed-test-only-'+JSON.stringify(results),'normalizeClaimMap',
    {claims:{[req]:{observedPaths:[],testResults:results,verdict:'matched'}}},{kind:'observed',...options,plannedClaims:{[req]:{expectedPaths:[],tests,fulfillment:'test-only'}}});
  add('inspect-complete','inspectPlannedClaimMap',table(basicRows),{...options,requireComplete:true});
  add('derive-complete','derivePlannedClaimMap',table(basicRows),options);
  add('inspect-missing-row','inspectPlannedClaimMap',table([basicRows[0]]),{...options,requireComplete:true});
  add('inspect-reordered','inspectPlannedClaimMap',table(basicRows).replace('Clause | Expected paths','Expected paths | Clause'),{...options,requireComplete:true});
  add('derive-reordered','derivePlannedClaimMap',table(basicRows).replace('Clause | Expected paths','Expected paths | Clause'),{...options,requireComplete:true});
  add('inspect-invalid-row','inspectPlannedClaimMap',table([`| ${req} | \`../escape.js\` | \`test/*.js\` |`]),{...options,requireComplete:true});
  add('inspect-duplicate','inspectPlannedClaimMap',table([basicRows[0],basicRows[0]]),options);
  add('inspect-unqualified','inspectPlannedClaimMap',table(['| REQ-001 | `src/value.js` | `test/value.test.js` |']),options);
  add('inspect-source-test-confusion','inspectPlannedClaimMap',table([`| ${req} | \`test/value.test.js\` | \`test/value.test.js\` |`]),options);
  add('inspect-configuration','inspectPlannedClaimMap',table([`| ${req} | \`package.json\` | \`test/value.test.js\` |`]),options);
  add('inspect-supporting','inspectPlannedClaimMap',table(basicRows)+'\n## Supporting files\n- `package.json` — Adds the required test dependency.\n',options);
  add('inspect-supporting-source','inspectPlannedClaimMap',table(basicRows)+'\n## Supporting files\n- `src/extra.js` — Adds extra behavior.\n',options);
  add('inspect-none-supporting','inspectPlannedClaimMap',table(basicRows)+'\n## Supporting files\n- none\n',options);
  add('inspect-masked','inspectPlannedClaimMap','```md\n'+table(basicRows)+'```\n',options);
  add('supporting-class-only','planSupportingFiles','## Supporting files\n- `package.json`\n');
  add('supporting-refused-class','planSupportingFiles','## Supporting files\n- `src/extra.js` — Extra behavior.\n');
  add('evidence-wrong-role','validatePlannedEvidenceTypes',{[req]:{expectedPaths:['evidence/screen.png'],tests,fulfillment:'new'}},{evidenceRoot:'evidence'});
  add('evidence-wrong-root','validatePlannedEvidenceTypes',{[ac]:{expectedPaths:['other/screen.png'],tests:[],fulfillment:'evidence'}},{evidenceRoot:'evidence'});
  add('evidence-as-test','validatePlannedEvidenceTypes',{[req]:{expectedPaths:source,tests:['evidence/screen.png']}},{evidenceRoot:'evidence'});
  const delivery={sourcePaths:source,testPaths:tests,traceability:{bindings:[{clauseId:ac,testSource:tests[0]}],sourceBindings:[{clauseId:req,sourcePath:source[0]},{clauseId:ac,sourcePath:source[0]}]}};
  add('projection-default','deriveObservedClaimMap',planned,delivery,{...options,generationCommit:'a'.repeat(40)});
  add('projection-exact-bindings','deriveObservedClaimMap',planned,delivery,{...options,generationCommit:'a'.repeat(64),requireSourceBindings:true});
  add('projection-without-bindings','deriveObservedClaimMap',planned,{sourcePaths:source,testPaths:tests},{...options,requireSourceBindings:true});
  add('projection-empty','deriveObservedClaimMap',planned,{},options);
  add('projection-bad-path','deriveObservedClaimMap',planned,{sourcePaths:['../escape.js']},options);
  add('projection-bad-commit','deriveObservedClaimMap',planned,delivery,{...options,generationCommit:'short'});
  add('projection-unbound-test','deriveObservedClaimMap',planned,{...delivery,traceability:{bindings:[{clauseId:'CLAIM:AC-999',testSource:tests[0]}]}},{...options,requireSourceBindings:true});
  for(const [fulfillment,state,pathValue] of [['existing','present',source[0]],['removed','absent',source[0]],['document','changed','docs/value.md'],['configuration','changed','package.json'],['evidence','present','evidence/screen.png']]) {
    const plan={claims:{[req]:{expectedPaths:[pathValue],tests:[],testDisposition:'not-applicable',testReason:'Reviewed exact inspection of the planned deliverable.',fulfillment}}};
    const actual={fulfillment:{obligations:[{clauseId:req,fulfillment,paths:[{path:pathValue,state,sha256:'a'.repeat(64)}]}]}};
    add('projection-'+fulfillment,'deriveObservedClaimMap',plan,actual,{});
    add('projection-wrong-'+fulfillment,'deriveObservedClaimMap',plan,{fulfillment:{obligations:[{clauseId:req,fulfillment,paths:[{path:pathValue,state:'other',sha256:'short'}]}]}},{});
  }
  add('projection-test-only','deriveObservedClaimMap',{claims:{[req]:{expectedPaths:[],tests,fulfillment:'test-only'}}},{testPaths:tests},{});
  add('test-only-proof','testOnlyClaimEvidence',req,{expectedPaths:[],tests,fulfillment:'test-only'},{observedPaths:[],testResults:tests});
  add('test-only-incomplete','testOnlyClaimEvidence',req,{expectedPaths:[],tests:[...tests,'test/other.test.js'],fulfillment:'test-only'},{observedPaths:[],testResults:tests});
  return cases;
}

/** Freeze only the native clock during one synchronous invocation; machine state stays isolated. */
export function nativeSpecificationClaimOutcome(api,entry) {
  const RealDate=globalThis.Date;let clocks=0;
  class FixedDate extends RealDate {constructor(...args){if(!args.length){clocks++;super(CLAIM_CAPTURE_TIME);}else super(...args);}static now(){return RealDate.parse(CLAIM_CAPTURE_TIME);}}
  globalThis.Date=FixedDate;
  try {return {result:api[entry.operation](...structuredClone(entry.args))??null,clocks};}
  catch(error){return {error:{name:error.name,code:error.code??null,message:error.message,details:error.details??null},clocks};}
  finally {globalThis.Date=RealDate;}
}

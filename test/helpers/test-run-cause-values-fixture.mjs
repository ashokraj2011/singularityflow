/** Value observations only. These messages and counts do not constitute retained test executions. */
export function testRunCauseValueCases(api){
  const cases=[],failed=(stderr,extra={})=>({status:'failed',exitCode:1,stdout:'',stderr,...extra}),
    add=(name,call)=>{try{cases.push({name,ok:true,value:call()});}catch(error){cases.push({name,ok:false,error:{message:error.message,code:error.code??null}});}},
    outputs=[['launcher','Unable to run quality command: spawn mvn ENOENT'],['dependency','sh: 1: jest: not found'],
      ['registry','npm ERR! code ENOTFOUND'],['certificate','PKIX path building failed'],['browser',"Executable doesn't exist at /missing/chromium"],
      ['toolchain','UnsupportedClassVersionError'],['device','ANDROID_DEVICE_UNAVAILABLE'],['docker','Cannot connect to the Docker daemon'],
      ['service','connect ECONNREFUSED 127.0.0.1:5432'],['port','Error: Port 4173 is already in use'],['permission','EACCES'],
      ['typescript','src/value.ts(3,7): error TS2322: incompatible'],['syntax','SyntaxError: unexpected token'],
      ['assertion','AssertionError [ERR_ASSERTION]: 2 !== 3'],['unknown','an unrecognised process failure'],
      ['code-before-environment','SyntaxError: unexpected token\nconnect ECONNREFUSED 127.0.0.1:5432'],
      ['import-package',"Cannot find package 'pg' imported from /work/repo/src/db.js"],
      ['import-relative',"Cannot find module '/work/repo/src/gone.js' imported from /work/repo/test/value.test.js"]];
  for(const [name,text]of outputs)for(const changed of [[],['src/db.js','src/value.ts']])add('process-'+name+'-'+changed.length,
    ()=>api.classifyTestRunCause({check:failed(text),changedPaths:changed}));
  for(const name of [...Object.keys(api.TEST_RUN_CAUSES),'browser-missing+service-unreachable','service-unreachable+browser-missing','syntax-error+service-unreachable','unknown-class','']){
    add('category-'+name,()=>api.testRunCauseCategory(name));add('words-'+name,()=>api.testRunCauseWords(name));}
  for(const messages of [null,[],['connect ECONNREFUSED'],['connect ECONNREFUSED','connect ECONNREFUSED'],['connect ECONNREFUSED','AssertionError [ERR_ASSERTION]'],
    ['connect ECONNREFUSED',null],["Executable doesn't exist at /missing/chromium",'connect ECONNREFUSED']])add('failed-messages-'+JSON.stringify(messages),()=>api.classifyTestRunCause({
      check:failed(''),tests:{discovered:2,passed:0,failed:2,skipped:0},failedMessages:messages}));
  for(const check of [{...failed('ECONNREFUSED'),timedOut:true},{...failed('ECONNREFUSED'),sourceMutation:true},
    {...failed(''),infrastructureUnavailable:true},failed('ECONNREFUSED'),{status:'passed',exitCode:0}]){
    for(const tests of [null,{discovered:0,passed:0,failed:0,skipped:0},{discovered:2,passed:2,failed:0,skipped:0},{discovered:2,passed:0,failed:0,skipped:2}])
      add('status-'+JSON.stringify({check,tests}),()=>api.classifyTestRunCause({check,tests}));}
  const json=JSON.stringify({testResults:[{name:'value.test.js',status:'failed',message:'Suite failed with connect ECONNREFUSED',assertionResults:[
    {status:'passed',failureMessages:[]},{status:'failed',failureMessages:['connect ECONNREFUSED 127.0.0.1:5432']}]}]}),
    suite=JSON.stringify({testResults:[{name:'load.test.js',status:'failed',message:'SyntaxError: unexpected token',assertionResults:[]}]}),
    tap='# sflow-node-messages-v1 '+JSON.stringify({messages:[null,'connect ECONNREFUSED 127.0.0.1:5432']})+'\n# sflow-node-observation-v1 '+JSON.stringify({occurrences:[{outcome:'passed'},{outcome:'failed'}]}),
    xml='<testsuites><testsuite><testcase name="passes"/><testcase name="fails"><failure message="expected &lt;2&gt;"><![CDATA[AssertionError\n at value.js:2]]></failure></testcase></testsuite></testsuites>';
  for(const [adapter,text]of [['vitest-json',json],['jest-json',json],['node-tap',tap],['junit-xml',xml],['unknown','anything']]){
    for(const count of [0,1,2,3])add('cases-'+adapter+'-'+count,()=>api.testCaseMessages(adapter,[Buffer.from(text)],count));
    add('bad-'+adapter,()=>api.testCaseMessages(adapter,[Buffer.from('not a report')],2));
  }
  for(const adapter of ['vitest-json','jest-json','node-tap','junit-xml','unknown'])add('suites-'+adapter,()=>api.failedSuiteMessages(adapter,[Buffer.from(suite)]));
  for(const value of ['',null,'\u001b[31mFailure\u001b[0m\r\n detail\u0000','a'.repeat(2100)])add('bounded-'+String(value).slice(0,20),()=>api.boundedCaseMessage(value));
  add('invalid-utf8-xml',()=>api.testCaseMessages('junit-xml',[Buffer.from([255,0,123])],1));
  add('split-utf8-json',()=>{const bytes=Buffer.from(json.replace('connect','cönnect')),offset=bytes.indexOf(Buffer.from('ö'))+1;
    return api.failedSuiteMessages('vitest-json',[bytes.subarray(0,offset),bytes.subarray(offset)]);});
  add('attempt-cause',()=>api.attemptRunCause({check:failed(''),parsed:{rawReports:[{contents:Buffer.from(json)}]},
    attempt:{adapter:'vitest-json',tests:{discovered:2,passed:1,failed:1,skipped:0},occurrences:[{outcome:'passed'},{outcome:'failed'}]},delivery:{sourcePaths:['src/value.js'],testPaths:['test/value.test.js']}}));
  return cases;
}

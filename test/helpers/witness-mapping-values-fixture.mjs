/** Inputs fixed before extraction; expected outcomes come from the original native module. */
import {createHash} from 'node:crypto';import {canonicalJson} from '../../src/foundation/record-schema.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),digest=value=>'sha256:'+hash(value),now=Date.parse('2026-11-08T12:00:00.000Z');
export function witnessMappingCases(){
  const core=(extra={})=>({clauseId:'EXAMPLE:AC-001',witnessType:'test',executionProfile:'node-test-v1',logicalTestId:digest('the exact test'),
    sourcePath:'test/value.test.mjs',sourceDeclarationSha256:digest('the exact declaration'),supportSha256:null,clauseBodySha256:digest('the exact criterion'),
    contractSha256:digest('the exact contract'),slot:'primary',...extra}),mapping=extra=>{const value=core(extra);return {mappingSha256:digest(canonicalJson(value)),...value};},
    m=mapping(),other=mapping({clauseId:'EXAMPLE:AC-002',logicalTestId:digest('the second test')}),cases=[],add=(name,input)=>cases.push({name,input:{now,...input}}),
    decision=(value={})=>({mappingSha256:m.mappingSha256,decision:'satisfied',...value});
  add('empty',{mappings:[]});add('one batch',{mappings:[m]});add('sorted batch',{mappings:[other,m]});add('duplicate mapping',{mappings:[m,m]});
  add('missing mapping',{mappings:[null]});add('false mapping digest',{mappings:[{...m,mappingSha256:digest('different')}]});
  for(const [key,values]of Object.entries({clauseId:['bad','EXAMPLE:REQ-001','EXAMPLE:AC-01'],witnessType:['file'],executionProfile:['unknown','module-counts-v1'],
    logicalTestId:['missing'],sourcePath:['/absolute','../escape','a/../b','test\\value.test.mjs','bad\u0000path',''],sourceDeclarationSha256:['bad'],
    supportSha256:['bad'],clauseBodySha256:['bad'],contractSha256:['bad'],slot:['Wrong','bad_slot','x'.repeat(33)]}))
    for(const value of values)add('invalid '+key+' '+JSON.stringify(value),{mappings:[mapping({[key]:value})]});
  add('optional nulls',{mappings:[mapping({slot:null,contractSha256:null,supportSha256:null})]});
  add('valid support',{mappings:[mapping({supportSha256:digest('supporting fixture')})]});
  for(const executionProfile of ['jest-static-v2','vitest-static-v2','junit5-surefire-v2','junit5-gradle-v2','playwright-json-v1','pytest-junit-v1'])
    add('supported '+executionProfile,{mappings:[mapping({executionProfile})]});
  add('satisfied explicit',{mappings:[m],decisions:[decision({reason:' reviewed '})]});
  add('unknown decision',{mappings:[m],decisions:[decision({decision:'approved'})]});
  add('unknown mapping decision',{mappings:[m],decisions:[decision({mappingSha256:other.mappingSha256})]});
  add('duplicate decision',{mappings:[m],decisions:[decision(),decision()]});
  for(const reason of ['', '  ','x'.repeat(4096),'x'.repeat(4097),'🧪'.repeat(1024),'🧪'.repeat(1025),'line\nwith\ttab','bad\u0000reason'])
    add('reason '+hash(reason).slice(0,12),{mappings:[m],decisions:[decision({decision:'not-applicable',reason})]});
  for(const extra of [{},{inadequate:[]},{inadequate:['unknown']},{inadequate:['boundaries']},{inadequate:['boundaries','boundaries']},
    {inadequate:['setup','action','assertions','boundaries','implementation']},{inadequate:['assertions'],expiresAt:'2026-11-01T00:00:00Z'},
    {inadequate:['assertions'],expiresAt:'invalid'},{inadequate:['assertions'],expiresAt:'2026-11-08T12:00:00.000Z'},
    {inadequate:['assertions'],expiresAt:'2026-12-01T12:00:00+05:30'}])
    add('exception '+hash(canonicalJson(extra)).slice(0,12),{mappings:[m],decisions:[decision({decision:'exception',reason:'The bounded review accepts the declared inadequate facet.',expiresAt:'2026-12-01T00:00:00Z',...extra})]});
  const prior=decision({decision:'exception',reason:'Original bounded review.',expiresAt:'2026-12-01T00:00:00Z',adequacy:{boundaries:'inadequate'}});
  add('carried exception',{mappings:[m],prior:[prior]});add('expired carry',{mappings:[m],prior:[{...prior,expiresAt:'2026-11-01T00:00:00Z'}]});
  add('explicit wins',{mappings:[m],prior:[prior],decisions:[decision()]});add('first prior wins',{mappings:[m],prior:[prior,decision()]});
  add('not-applicable carry',{mappings:[m],prior:[decision({decision:'not-applicable',reason:'Earlier reviewed exclusion.'})]});
  add('unknown prior ignored',{mappings:[m],prior:[decision({mappingSha256:other.mappingSha256})]});add('malformed prior',{mappings:[m],prior:null});
  add('mapping collection invalid',{mappings:{}});add('decision collection invalid',{mappings:[m],decisions:null});
  add('mapping limit',{mappings:Array.from({length:1001},()=>m)});add('decision limit',{mappings:[m],decisions:Array.from({length:1001},()=>decision())});
  return cases;
}
export function observeWitnessMapping(fn,input){
  try{const value=fn(input),text=canonicalJson(value);return Buffer.byteLength(text)>8192?{kind:'return-digest',bytes:Buffer.byteLength(text),sha256:hash(text)}:{kind:'return',value};}
  catch(error){return {kind:'throw',name:error.name,message:error.message,...(error.code?{code:error.code}:{}),...(error.details?{details:error.details}:{})};}
}

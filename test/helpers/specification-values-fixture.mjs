/** Inputs captured against the installed native owners before their extraction. */
const req='VALUE:REQ-001', ac='VALUE:AC-001';
const clauses=[{id:req},{id:ac}];
const planned={ [ac]:{tests:['test/value.test.js'],testDisposition:'applicable'} };
const header='## Verification contracts\n| Criterion | Slot | Method | Witness | Role | Required assurance | Combination | Reason |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
const table=(...rows)=>header+rows.join('\n')+'\n';
const row=(fields={})=>`| ${fields.criterion??ac} | ${fields.slot??'unit'} | ${fields.method??'test'} | ${fields.witness??'`test/value.test.js`'} | ${fields.role??''} | ${fields.assurance??''} | ${fields.combination??''} | ${fields.reason??''} |`;
const intent=(rows)=>'## Verification intent\n| Clause | Methods | Criterion |\n| --- | --- | --- |\n'+rows.join('\n')+'\n';
const contract={clauseId:ac,combination:'all',slots:[{slot:'unit',method:'test',role:'primary',witness:{path:'test/value.test.js'},requiredAssurance:null}]};
const visual={clauseId:ac,combination:'all',slots:[{slot:'screen',method:'visual',role:'primary',witness:{target:'Value screen'},requiredAssurance:'source-bound'}]};

export function specificationValueCases() {
  const cases=[];
  const add=(name,operation,...args)=>cases.push({name,operation,args});
  const extract=(name,text,options={})=>add(name,'extractClauses',text,options);
  extract('empty','');
  extract('own-lines',`[${req}]\nAccept café 😀.\n\n[${ac}]\nDepends on ${req}. Returns FF.\n`,{sourcePath:'docs/spec.md',namespace:'VALUE'});
  extract('trailing-list',`- Accept a value. [${req}]\n- Returns FF. [${ac}]\n`);
  extract('leading-table',`| ID | Outcome |\n| --- | --- |\n| [${req}] | Accept a value |\n| [${ac}] | Return FF |\n`);
  extract('heading',`## [${req}] Conversion\n\nAccept a positive integer.\n\n## Next\nIgnored section.\n`);
  extract('two-in-paragraph',`Accept input [${req}]. Return FF [${ac}].\n`);
  extract('leading-siblings',`[${req}] Accept input. [${ac}] Return FF.\n`);
  extract('mixed-case','[value:req-001]\nAccept input.\n\n[value:ac-001]\nDepends on VaLuE:rEq-001.');
  extract('masked',`\`[VALUE:REQ-099]\`\n\n\`\`\`md\n[VALUE:REQ-098]\n\`\`\`\n<!-- [VALUE:REQ-097] -->\n<!-- singularity-flow:inputs:start -->\n[VALUE:REQ-096]\n<!-- singularity-flow:inputs:end -->\n[${req}]\nReal statement.\n`);
  extract('duplicates',`[${req}] First.\n\n[VALUE:req-001] Second.`);
  extract('namespace-mismatch',`[${req}] Statement.`,{namespace:'OTHER'});
  extract('missing-dependency',`[${ac}] Depends on VALUE:REQ-009.`);
  extract('external-id',`[${ac}] Depends on VALUE:REQ-009.`,{externalClauseIds:['value:req-009']});
  extract('external-record',`[${ac}] Depends on ${req}.`,{externalClauses:[{id:req,source:{path:'previous.md',line:7},dependsOn:[]}]});
  extract('redefinition',`[${req}] Changed.`,{externalClauses:[{id:req,source:{path:'previous.md',line:7},dependsOn:[]}]});
  extract('cycle',`[${req}] Depends on ${ac}.\n\n[${ac}] Depends on ${req}.`);
  extract('external-cycle',`[${ac}] Depends on ${req}.`,{externalClauses:[{id:req,dependsOn:[ac]}]});
  extract('clause-limit',`[${req}] One.\n\n[${ac}] Two.`,{limits:{maxClausesPerArtifact:1,maxDependenciesPerClause:8}});
  extract('dependency-limit',`[${ac}] ${req} and VALUE:REQ-002.`,{limits:{maxClausesPerArtifact:10,maxDependenciesPerClause:1}});
  extract('invalid-input',null);
  extract('intent-index',`[${req}] Accept.\n\n[${ac}] Observe.\n\n`+intent([`| ${req} | visual | ${ac} |`,`| ${ac} | visual | - |`]));
  add('references-boundaries','clauseReferences','VALUE:REQ-001 XVALUE:REQ-001 VALUE:REQ-0010 value:ac-001 OTHER:REQ-001-extra');
  const hidden=`Visible\n<!-- singularity-flow:metadata:start -->\n[VALUE:REQ-099]\n<!-- singularity-flow:metadata:end -->\n\`\`\`md\n[VALUE:REQ-098]\n\`\`\`\n\`inline\`\n<!-- note -->\n`;
  add('ignored-regions','ignoredRanges',hidden);
  add('author-visible','plannedClaimSource',hidden);
  add('canonical-nested','canonicalJson',{z:[{b:2,a:1}],a:'café 😀'});
  for(const [name,fields] of [
    ['default',{}],['inspection',{method:'inspection',witness:'`docs/runbook.md`',assurance:'source-bound'}],
    ['visual',{method:'visual',witness:'`Value screen`',assurance:'declared'}],
    ['unknown-criterion',{criterion:'VALUE:AC-999'}],['bad-slot',{slot:'Not A Slot'}],
    ['unsupported-method',{method:'measurement'}],['supporting-only',{role:'supporting'}],
    ['any-no-reason',{combination:'any'}],['any-reviewed',{combination:'any',reason:'Either independent suite fully proves the outcome.'}],
    ['wrong-assurance',{assurance:'source-bound'}],['unqualified-assurance',{assurance:'exact-authenticated'}],
    ['witness-prose',{witness:'`test/value.test.js` (exact-local-observed)'}],
    ['bad-visual',{method:'visual',witness:'`'+('x'.repeat(201))+'`'}],
    ['short-reason',{reason:'why'}],['missing-planned-test',{witness:'`test/other.test.js`'}]
  ])add('contract-'+name,'parseVerificationContracts',table(row(fields)),{clauseIds:[req,ac],plannedClaims:planned});
  for(const candidate of ['../escape.js','./test/a.js','test//a.js','/tmp/a.js','C:/a.js','test\\a.js','https://host/a','test/*.js','<file>.js','test/a.js/','test/a\0.js']) {
    add('contract-path-'+JSON.stringify(candidate),'parseVerificationContracts',table(row({witness:'`'+candidate+'`'})),{clauseIds:[ac]});
  }
  add('duplicate-slot','parseVerificationContracts',table(row(),row()),{clauseIds:[ac]});
  add('all-and-any','parseVerificationContracts',table(row({combination:'all'}),row({slot:'other',combination:'any',reason:'Each witness independently proves the outcome.'})),{clauseIds:[ac]});
  add('fenced-contract','parseVerificationContracts','```md\n'+table(row())+'```\n',{clauseIds:[ac]});
  add('prose-needs-slot','parseVerificationContracts',`Primary visual verification contract for ${ac}.`,{clauseIds:[ac]});
  add('evidence-needs-primary','parseVerificationContracts','',{clauseIds:[ac],plannedClaims:{[ac]:{fulfillment:'evidence',expectedPaths:['evidence/screen.png']}}});
  add('not-applicable-test-slot','parseVerificationContracts',table(row()),{clauseIds:[ac],plannedClaims:{[ac]:{testDisposition:'not-applicable'}}});
  add('collected-diagnostics','inspectContracts',table(row({slot:'Bad',method:'manual',role:'other',assurance:'unknown'})),{clauseIds:[ac]});
  add('normalized-contracts','normalizeVerificationContracts',[{...contract,clauseId:'value:ac-001'}]);
  add('duplicate-normalized','normalizeVerificationContracts',[contract,contract]);
  add('no-primary-normalized','normalizeVerificationContracts',[{...contract,slots:[]}]);
  add('invalid-record-path','normalizeVerificationContracts',[{...contract,slots:[{...contract.slots[0],witness:{path:'../escape'}}]}]);
  add('merged-contracts','mergedVerificationContracts',[{verificationContracts:[contract]},{verificationContracts:[visual]}]);
  add('default-contract','effectiveContract',ac,[],planned[ac]);
  add('stated-contract','effectiveContract',ac,[[ac,visual]],planned[ac]);
  add('not-applicable-contract','effectiveContract',ac,[],{testDisposition:'not-applicable'});
  add('contract-test-tag','contractRequiresTestTag',contract);
  add('visual-no-tag','contractRequiresTestTag',visual);
  add('test-slot','testSlotFor',contract,{testSource:'test/value.test.js'});
  add('contract-digest','contractSha256',{...contract,stated:true});
  add('contract-null-digest','contractSha256',null);
  const witness={clauseId:ac,profile:'jest-static-v2',logicalTestId:'sha256:'+'1'.repeat(64),testSource:'test/value.test.js',declarationSha256:'2'.repeat(64),supportSha256:'3'.repeat(64)};
  add('witness-mapping','witnessMappingCore',witness,{clauseBodySha256:'4'.repeat(64),contract});
  add('witness-digest','witnessMappingSha256',{clauseId:ac,slot:'unit',nested:{b:2,a:1}});
  add('prose-declarations','proseVerificationDeclarations',`Primary visual verification contract for ${ac}.\n\nPrimary inspection verification contract for value:ac-002.\n`);
  add('retained-evidence-typed','validateRetainedEvidenceDeclarations','Inspect `evidence/screen.png`.',{[ac]:{fulfillment:'evidence',expectedPaths:['evidence/screen.png']}},{evidenceRoot:'evidence'});
  add('retained-evidence-untyped','validateRetainedEvidenceDeclarations','Inspect `evidence/screen.png`.',{}, {evidenceRoot:'evidence'});
  const goodRows=[`| ${req} | visual | ${ac} |`,`| ${ac} | visual | - |`];
  add('historical-intent','parseVerificationIntent','No table.',clauses);
  add('visual-intent','parseVerificationIntent',intent(goodRows),clauses);
  add('intent-wrong-header','parseVerificationIntent',intent(goodRows).replace('Clause | Methods','Item | Methods'),clauses);
  add('intent-missing-row','parseVerificationIntent',intent([goodRows[0]]),clauses);
  add('intent-duplicate','parseVerificationIntent',intent([...goodRows,goodRows[0]]),clauses);
  add('intent-method-weakened','parseVerificationIntent',intent([`| ${req} | test, visual | ${ac} |`,`| ${ac} | visual | - |`]),clauses);
  add('intent-undeclared','parseVerificationIntent',intent([`| REQ-001 | test | - |`]),clauses);
  add('intent-non-test-missing-criterion','parseVerificationIntent',intent([`| ${req} | visual | - |`,`| ${ac} | visual | - |`]),clauses);
  add('non-test-proof','nonTestVerification',ac,{verificationCriterion:ac},[[ac,visual]],{methods:['visual'],criterionId:ac});
  add('non-test-not-waiver','nonTestVerification',ac,{verificationCriterion:ac},[[ac,visual]],{methods:['test','visual'],criterionId:ac});
  add('planned-test-required','validatePlannedVerification',{[ac]:{tests:[],testDisposition:'non-test',verificationCriterion:ac}},[visual],[{id:ac,verification:{methods:['test'],criterionId:ac}}]);
  add('planned-visual-valid','validatePlannedVerification',{[ac]:{tests:[],testDisposition:'non-test',verificationCriterion:ac}},[visual],[{id:ac,verification:{methods:['visual'],criterionId:ac}}]);
  add('diagnostic-bound','diagnostics',260);
  return cases;
}

/** Dispatch only; validation and digest decisions always belong to the actual owner under test. */
export function invokeSpecificationValueCase(api,entry) {
  const args=structuredClone(entry.args);
  if(entry.operation==='effectiveContract')args[1]=new Map(args[1]);
  if(entry.operation==='nonTestVerification')args[2]=new Map(args[2]);
  if(entry.operation==='inspectContracts') {
    const diagnostics=[];
    const contracts=api.parseVerificationContracts(args[0],{...args[1],diagnostics});
    return {contracts,diagnostics,summary:api.draftDiagnosticSummary(diagnostics)};
  }
  if(entry.operation==='diagnostics') {
    const diagnostics=[];
    for(let index=0;index<args[0];index++)api.collectDraftDiagnostic(diagnostics,{message:'Exact path required.',code:'VALUE_INVALID'},{line:index+1,actual:'<file>'});
    return {count:diagnostics.length,first:diagnostics[0],last:diagnostics.at(-1),summary:api.draftDiagnosticSummary(diagnostics)};
  }
  return api[entry.operation](...args);
}

export function specificationValueProjection(value) {
  if(value===undefined)return null;
  if(value instanceof Map)return [...value].map(([key,item])=>[key,specificationValueProjection(item)]);
  if(value instanceof Set)return [...value];
  if(Array.isArray(value))return value.map(specificationValueProjection);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,specificationValueProjection(item)]));
  return value;
}

export function specificationValueOutcome(api,entry) {
  try {return {result:specificationValueProjection(invokeSpecificationValueCase(api,entry))};}
  catch(error) {return {error:{name:error.name,code:error.code??null,message:error.message,details:specificationValueProjection(error.details??null)}};}
}

export const specificationIndexInputs=Object.freeze([
  {name:'ordinary',text:`[${req}] Accept an integer.\n\n[${ac}] Depends on ${req}. Return FF.\n`,options:{workId:'value',phase:'specification',generation:1,policy:{namespace:'VALUE'}}},
  {name:'unicode-crlf',text:`[${req}] Café 😀.\r\n\r\n[${ac}] Return π.\r\n`,options:{workId:'value',phase:'custom',generation:'2'}},
  {name:'empty',text:'No clauses.\n',options:{}},
  {name:'lossy-native-utf8',bytes:[91,86,65,76,85,69,58,82,69,81,45,48,48,49,93,32,255,10],options:{workId:'value',phase:'specification',generation:1}}
]);

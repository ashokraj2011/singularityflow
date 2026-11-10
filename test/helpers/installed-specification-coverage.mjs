/** Installed rule replay; all observation facts are explicit and infrastructure is denied. */
import assert from 'node:assert/strict';import path from 'node:path';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';
const oracle=JSON.parse('__COVERAGE_ORACLE__'),unexpected=[],hook=registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('node:')){unexpected.push(specifier);throw Error('Unexpected coverage infrastructure: '+specifier);}return next(specifier,context);
}}),pure=await import('@sdk-name@/specifications'),paths=Object.freeze({profile:pure.CONFIGURATION_PATH_SYNTAX_V2,grammar:path.sep==='\\'?'win32':'posix',
  isAbsolute:path.isAbsolute,normalize:path.normalize,parse:path.parse,posixIsAbsolute:path.posix.isAbsolute,posixNormalize:path.posix.normalize,
  posixBasename:path.posix.basename,posixDirname:path.posix.dirname,posixRelative:path.posix.relative,win32IsAbsolute:path.win32.isAbsolute,toPosix:value=>value.split(path.sep).join('/')}),
  text=Object.freeze({profile:pure.TEXT_VALUE_SYNTAX_PROFILE,byteLengthUtf8:value=>Buffer.byteLength(value),sha256Utf8:value=>createHash('sha256').update(value).digest('hex')}),
  values=pure.specificationClaimPolicies(paths,text),ordinary=value=>JSON.parse(JSON.stringify(value));
function drive(replay,read){let step=replay.next();while(!step.done){assert.equal(Object.isFrozen(step.value),true);step=replay.next(read(step.value));}return step.value;}
const facts=request=>{if(request.kind==='specification-coverage-path')return ['src/value.mjs','test/value.test.mjs'].includes(request.path);
  assert.equal(request.kind,'specification-coverage-commit');return request.commit==='@reachable-commit@';};
async function verify(api){
 for(const row of oracle.rows){let result;try{const args=row.args,value=row.method==='evaluateSpecCoverage'
   ?drive(api.evaluateSpecCoverageReplay(...args.slice(0,3),{...args[3],verifyEvidence:row.host===true}),facts)
   :(api[row.method]??pure[row.method])(...args);result={value};
 }catch(error){result={error:{name:error.name,code:error.code??null,message:error.message,details:error.details??null}};}assert.deepEqual(ordinary(result),row.outcome,row.name);}
 for(const row of oracle.candidates){const result=drive(api.candidateSpecificationCoverageReplay({},row.workflow,row.workflow.phases.code,row.delivery,
   {pathContext:{caseInsensitivePaths:false,governedRoots:[],governedPaths:[]}}),request=>request.kind==='specification-claim-timestamp'?'2026-01-01T00:00:00.000Z':structuredClone(row.records));
   if(row.outcome.value===null)assert.equal(result,null);else if(row.outcome.error){assert.equal(result.status,'correction-required');assert.deepEqual(result.coverage,row.outcome.error.details.coverage);assert.deepEqual(result.claimGaps,row.outcome.error.details.claimGaps);}
   else{const {advisory,...coverage}=row.outcome.value;assert.equal(result.status,advisory?'advisory':'ready');assert.deepEqual(result.coverage,coverage);}}
}
assert.equal(oracle.rows.length,470);assert.equal(oracle.candidates.length,19);await verify(values);assert.deepEqual(unexpected,[]);hook.deregister();
const node=await import('@sdk-name@/specifications/node');await verify(node);
assert.equal(node.codeCoverageEnforcement,pure.codeCoverageEnforcement);assert.equal(node.selectActiveSpecRecords,pure.selectActiveSpecRecords);
assert.equal(Object.hasOwn(values,'publish'),false);assert.equal(Object.hasOwn(values,'approve'),false);

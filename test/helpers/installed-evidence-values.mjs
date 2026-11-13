/** The installed evaluator has no filesystem, process, Git or ambient clock capability. */
import assert from 'node:assert/strict';import path from 'node:path';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';
const captured=JSON.parse('__EVIDENCE_ORACLE__'),unexpected=[],hook=registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('node:')){unexpected.push(specifier);throw Error('Unexpected evidence infrastructure: '+specifier);}return next(specifier,context);
}}),pure=await import('@sdk-name@/evidence'),syntax=await import('@sdk-name@/specifications'),
  paths=Object.freeze({profile:syntax.CONFIGURATION_PATH_SYNTAX_V2,grammar:path.sep==='\\'?'win32':'posix',isAbsolute:path.isAbsolute,normalize:path.normalize,parse:path.parse,
    posixIsAbsolute:path.posix.isAbsolute,posixNormalize:path.posix.normalize,posixBasename:path.posix.basename,posixDirname:path.posix.dirname,
    posixRelative:path.posix.relative,win32IsAbsolute:path.win32.isAbsolute,toPosix:value=>value.split(path.sep).join('/')}),
  text=Object.freeze({profile:syntax.TEXT_VALUE_SYNTAX_PROFILE,byteLengthUtf8:value=>Buffer.byteLength(value),sha256Utf8:value=>createHash('sha256').update(value).digest('hex')}),
  digests=Object.freeze({profile:syntax.TEXT_DIGEST_PROFILE,sha256Utf8:text.sha256Utf8}),rules=pure.evidenceEvaluationPolicies(paths,text,digests);
for(const fixture of captured.cases){
  assert.equal(rules.evidenceGraph(fixture.graph).inputSha256,fixture.graphSha256);
  // Native presence admitted no unsigned votes in this case. It is observation data, not an authority grant.
  const admission=fixture.name==='native person presence unavailable'?{reviewApprovals:Object.fromEntries(Object.keys(fixture.graph.workflow.phases).map(id=>[id,[]]))}:{};
  const result=rules.evaluateEvidence(fixture.graph,{...fixture.options,admission});
  assert.equal(result.profile,pure.EVIDENCE_EVALUATION_PROFILE);assert.deepEqual(result.decision,fixture.result.decision);
  assert.deepEqual(result.completion,fixture.result.completion);assert.deepEqual(result.rows.map(row=>row.obligations),fixture.result.rows.map(row=>row.obligations));
  assert.ok(result.rows.flatMap(row=>row.actions).every(row=>!Object.hasOwn(row,'command')));
}
assert.throws(()=>rules.evaluateEvidence(captured.cases[0].graph),{code:'ENGINE_INPUT_INVALID'});
assert.equal(Object.hasOwn(rules,'publish'),false);assert.equal(Object.hasOwn(rules,'approve'),false);
assert.deepEqual(unexpected,[]);hook.deregister();

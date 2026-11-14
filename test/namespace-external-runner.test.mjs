import test from 'node:test';import assert from 'node:assert/strict';import {rm,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {externalPythonFixture} from './helpers/external-python-runner.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
for(const backend of ['filesystem','sqlite','application'])test('an actual pinned Python runner retains exact JUnit counts and reopens without an interpreter: '+backend,{timeout:120000},async t=>{
 const f=await namespacePhaseCheckFixture(t,{backend,external:await externalPythonFixture()}),result=await f.engine.run('phase.checks.run',f.input);
 assert.equal(f.checks.bindings[0].unit.observeEnvironment,undefined);assert.equal(f.checks.bindings[0].unit.selectTestFiles,undefined);
 assert.equal(result.verdict,'passed');assert.equal(result.checks[0].tests.passed,2);assert.equal(result.checks[0].tests.failed,0);
 const actual=await createNamespacePhaseCheckReader(f.options).accepted(f.input);assert.equal(actual.plan.steps[0].manifest.toolPolicy.profile,'sflow-external-check-execution/v1');
 assert.equal(actual.body.results[0].candidate.output.reports.raw[0].path,'results/tests.xml');assert.equal(f.control.starts,1);
 await rm(f.root,{recursive:true,force:true});const offline=f.make({sources:[],checks:{mode:'retained-only'},localRecords:null,localContent:null});
 assert.deepEqual((await offline.run('phase.checks.run',f.input)).record,result.record);assert.equal(f.control.starts,1);
});
test('external assertion failure and a non-test command retain distinct facts',{timeout:120000},async t=>{
 const failed=await namespacePhaseCheckFixture(t,{backend:'sqlite',external:await externalPythonFixture({failing:true})}),run=await failed.engine.run('phase.checks.run',failed.input);
 assert.equal(run.verdict,'failed');assert.equal(run.checks[0].tests.failed,1);assert.equal(run.checks[0].tests.passed,1);
 const compiler=await namespacePhaseCheckFixture(t,{backend:'sqlite',external:await externalPythonFixture({commandKind:'compile'})}),syntax=await compiler.engine.run('phase.checks.run',compiler.input);
 assert.equal(syntax.verdict,'passed');assert.equal(syntax.checks[0].tests,null);
 await writeFile(path.join(compiler.root,'calculator.py'),'def = broken syntax');const bad=await compiler.engine.run('phase.checks.run',{...compiler.input,operationId:'syntax-after-change'});
 assert.equal(bad.verdict,'failed');assert.equal(bad.checks[0].tests,null);
});
test('a previously passing external report cannot replace a fresh or missing report',{timeout:120000},async t=>{
 const f=await namespacePhaseCheckFixture(t,{backend:'sqlite',external:await externalPythonFixture()});
 assert.equal((await f.engine.run('phase.checks.run',f.input)).verdict,'passed');
 await writeFile(path.join(f.root,'run_checks.py'),'print("No structured tests executed")\n');
 const stale=await f.engine.run('phase.checks.run',{...f.input,operationId:'stale-external-report'});
 assert.equal(stale.verdict,'unavailable');assert.equal(stale.checks[0].tests,null);
 assert.ok(stale.checks[0].diagnostics.some(row=>row.code==='SGOS_CHECK_REPORT_STALE'&&row.path==='results/tests.xml'));
 await rm(path.join(f.root,'results/tests.xml'));
 const missing=await f.engine.run('phase.checks.run',{...f.input,operationId:'missing-external-report'});
 assert.equal(missing.verdict,'unavailable');assert.equal(missing.checks[0].tests,null);
 assert.ok(missing.checks[0].diagnostics.some(row=>row.code==='ENOENT'&&row.path==='results/tests.xml'));
});
test('an external runner that changes its checked source cannot certify it',{timeout:120000},async t=>{
 const external=await externalPythonFixture();external.files['run_checks.py']=external.files['run_checks.py'].replace('sys.exit(0 if result.wasSuccessful() else 1)',
  "pathlib.Path('calculator.py').write_text('def increment(value): return 0\\n')\nsys.exit(0 if result.wasSuccessful() else 1)");
 const f=await namespacePhaseCheckFixture(t,{backend:'sqlite',external});
 await assert.rejects(f.engine.run('phase.checks.run',f.input),error=>error.code==='ENGINE_SOURCE_CHANGED'&&error.details.newOperationRequired===true);
 const reader=createNamespacePhaseCheckReader(f.options);assert.ok(await reader.intent(f.input));assert.equal(await reader.accepted(f.input),null);
 assert.equal(await readFile(path.join(f.root,'calculator.py'),'utf8'),'def increment(value): return 0\n');
 await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_SOURCE_CHANGED'});assert.equal(f.control.starts,1);
});
test('an external process deadline remains a timeout with no invented tests',{timeout:120000},async t=>{
 const external=await externalPythonFixture();external.command.timeoutMs=1000;external.files['run_checks.py']='import time\ntime.sleep(10)\n';
 const f=await namespacePhaseCheckFixture(t,{backend:'sqlite',external}),result=await f.engine.run('phase.checks.run',f.input);
 assert.equal(result.verdict,'failed');assert.equal(result.checks[0].tests,null);
 const actual=await createNamespacePhaseCheckReader(f.options).accepted(f.input),process=actual.body.results[0].candidate.output.process;
 assert.equal(process.timedOut,true);assert.equal(process.closed,true);assert.notEqual(process.status,0);assert.equal(f.control.starts,1);
});

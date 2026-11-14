/** Qualification host discovery only. The SDK receives a real absolute executable and its bytes. */
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,realpath} from 'node:fs/promises';import {createHash} from 'node:crypto';
let runtime;
export async function externalPythonRuntime(){
 return runtime??=Promise.resolve().then(async()=>{const program=process.env.SFLOW_TEST_PYTHON??(process.platform==='win32'?'python':'python3'),
  result=await promisify(execFile)(program,['-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:15000}),executable=await realpath(result.stdout.trim());
  return {executable,executableSha256:'sha256:'+createHash('sha256').update(await readFile(executable)).digest('hex')};});
}
export const pythonJUnitRunner=`import unittest, sys, pathlib, xml.etree.ElementTree as ET
class RetainedResult(unittest.TextTestResult):
 def __init__(self,*args,**kwargs): super().__init__(*args,**kwargs); self.observed=[]
 def addSuccess(self,test): super().addSuccess(test); self.observed.append((test,'passed',None))
 def addFailure(self,test,err): super().addFailure(test,err); self.observed.append((test,'failure',self._exc_info_to_string(err,test)))
 def addError(self,test,err): super().addError(test,err); self.observed.append((test,'error',self._exc_info_to_string(err,test)))
 def addSkip(self,test,reason): super().addSkip(test,reason); self.observed.append((test,'skipped',reason))
suite=unittest.defaultTestLoader.discover('test')
result=unittest.TextTestRunner(stream=sys.stderr,resultclass=RetainedResult).run(suite)
report=ET.Element('testsuite',name='actual-python-unittest',tests=str(result.testsRun),failures=str(len(result.failures)),errors=str(len(result.errors)),skipped=str(len(result.skipped)))
for case,outcome,detail in result.observed:
 row=ET.SubElement(report,'testcase',name=case._testMethodName,classname=case.__class__.__module__+'.'+case.__class__.__name__)
 if outcome!='passed': ET.SubElement(row,outcome).text=detail
pathlib.Path('results').mkdir(exist_ok=True)
ET.ElementTree(report).write('results/tests.xml',encoding='utf-8',xml_declaration=True)
sys.exit(0 if result.wasSuccessful() else 1)
`;
export async function externalPythonFixture({failing=false,commandKind='test'}={}){
 const runtime=await externalPythonRuntime(),environment={PYTHONDONTWRITEBYTECODE:'1'},
  command=commandKind==='test'?{id:'python-tests',argv:['python3','run_checks.py'],kind:'test',modelPolicy:'never',env:environment,
    result:{adapter:'junit-xml',path:'results/tests.xml',minimumDiscovered:2,minimumPassed:2}}:
    {id:'python-compile',argv:['python3','-c',"import ast, pathlib; ast.parse(pathlib.Path('calculator.py').read_text()); print('syntax checked')"],kind:commandKind,modelPolicy:'never',env:environment},
  files={'calculator.py':'def increment(value):\n if value < 0: raise ValueError("non-negative values only")\n return value + 1\n',
    'run_checks.py':pythonJUnitRunner,'test/test_calculator.py':'import unittest\nfrom calculator import increment\nclass CalculatorTests(unittest.TestCase):\n def test_increment(self): self.assertEqual(increment(2),'+(failing?'4':'3')+')\n def test_boundary(self):\n  with self.assertRaises(ValueError): increment(-1)\n'};
 return {runtime,environment,command,files,...(commandKind==='test'?{report:{adapter:'junit-xml',files:['results/tests.xml']}}:{})};
}

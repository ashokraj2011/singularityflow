import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceCodePreflightReader} from '../src/engine-storage/namespace-code-preflight.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
test('a reviewed test-only phase preserves declared source-binding exemption without inventing product edits',async t=>{
  const source='export const convert=value=>value.toString(16).toUpperCase();\n',plan='# Plan\n\n| Clause | Expected paths | Planned tests | Fulfillment |\n| --- | --- | --- | --- |\n'
    +'| STORY-1:REQ-001 | | `test/converter.test.js` | test-only |\n'
    +'| STORY-1:AC-001 | | `test/converter.test.js` | test-only |\n',
    f=await namespaceSourceClauseFixture(t,{source,baselineSource:source,plan,configure:source=>{source.definition.phases.build.sourceBoundary='test-automation';},
      testSource:"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\ntest('already implemented conversion',()=>assert.equal(convert(255),'FF'));\n"}),
    snapshot=await f.capture(),before=await f.head(),retention=createNamespaceSourceRetentionReader(f.common),found=await retention.accepted({operationId:'clause-current-bytes',workId:f.inputs.workId,phaseId:'build'}),
    result=await createNamespaceCodePreflightReader(f.common).inspect(snapshot,'build',{phaseId:'build',generation:found.plan.generation,baseRevision:snapshot.revision,
      draft:found.plan.draft,artifact:found.plan.artifact,configuration:snapshot.configuration}),{delivery,coverage}=result.repositories[0];
  assert.deepEqual(delivery.sourcePaths,[]);assert.deepEqual(delivery.testPaths,['test/converter.test.js']);assert.equal(delivery.implementationBindings,null);
  assert.equal(delivery.sourceBindings.mode,'off');assert.equal(coverage.status,'ready');assert.deepEqual(await f.head(),before);
});

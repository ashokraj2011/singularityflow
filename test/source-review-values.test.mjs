import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import * as native from '../src/source-grounded-review.mjs';
import {sourceGroundedReviewPolicies} from '../src/kernel/source-grounded-review.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {sourceReviewValueCases,sourceReviewValueOutcome} from './helpers/source-review-values-fixture.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/source-review-values/native-v1.json',import.meta.url),'utf8')),
  values=sourceGroundedReviewPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS),
  shared={...values,evaluateSourceGroundedReview(report,context){const replay=values.evaluateSourceGroundedReviewReplay(report,context);let step=replay.next();
    while(!step.done)step=replay.next('2026-11-10T01:00:00.000Z');return step.value;}};
test('the source-review oracle precedes the pure extraction',()=>{assert.equal(oracle.capturedAtCommit,'4c36b3275');assert.deepEqual(oracle.cases.map(({outcome,...row})=>row),sourceReviewValueCases());});
for(const row of oracle.cases)test('source-review compatibility: '+row.name,()=>{
  assert.deepEqual(sourceReviewValueOutcome(shared,row),row.outcome,'pure rules');
  assert.deepEqual(sourceReviewValueOutcome(native,row),row.outcome,'native facade');
});

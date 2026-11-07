import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeClarificationPolicy,markerPolicy,MARKER_MODES,clarificationCheckpointState} from '../src/kernel/phase-inputs.mjs';
import {normalizeClarificationPolicy as legacyNormalizer,clarificationCheckpoint} from '../src/clarifications.mjs';
import {markerPolicy as legacyMarker,MARKER_MODES as legacyModes} from '../src/clarification-markers.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

test('clarification and marker compatibility exports have one pure owner with unchanged values and errors',()=>{
  assert.equal(normalizeClarificationPolicy,legacyNormalizer);assert.equal(markerPolicy,legacyMarker);assert.equal(MARKER_MODES,legacyModes);
  assert.deepEqual(normalizeClarificationPolicy(),{mode:'off',maxQuestions:5,topics:[],markers:{mode:'off'}});
  assert.deepEqual(normalizeClarificationPolicy({mode:'required',maxQuestions:10,topics:['  risk  '],markers:'block'}),{
    mode:'required',maxQuestions:10,topics:['risk'],markers:{mode:'block'}});
  for(const [input,message] of [[{mode:'other'},'clarification.mode must be off, when-needed, or required.'],
    [{maxQuestions:0},'clarification.maxQuestions must be an integer from 1 through 10.'],
    [{topics:['risk',' risk ']},'clarification.topics must not contain duplicates.']]) {
    assert.throws(()=>normalizeClarificationPolicy(input),error=>error instanceof SingularityFlowError&&error.message===message);
  }
});

test('native clarification wording uses the same checkpoint state as every registered entry',()=>{
  for(const mode of ['off','when-needed','required'])for(const recordState of ['not-applicable','missing','invalid','stale-or-incomplete','complete'])
    for(const errors of [[],['binding failed']]) {
      const native=clarificationCheckpoint({mode},{recordState,errors});
      const kernel=clarificationCheckpointState(mode,recordState,errors.length);
      assert.deepEqual({stage:native.stage,questioningAllowed:native.questioningAllowed,requiresHumanResponse:native.requiresHumanResponse},kernel);
    }
});

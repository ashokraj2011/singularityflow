/** Native record reads and error presentation; deterministic convergence rules have one pure owner. */
export {assertNoAutonomousConvergence} from './kernel/configuration-declarations.mjs';
export {advancementBlocked} from './kernel/phase-policy.mjs';
export {FACT_KINDS,FINDING_CLASSIFICATIONS,DISPOSITIONS} from './kernel/convergence-values.mjs';
import {convergenceValuePolicies} from './kernel/convergence-values.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from './records.mjs';
import {currentSchemaVersion,readRecord} from './schema-migrations.mjs';
import {SingularityFlowError} from './foundation/failures.mjs';
export const CONVERGENCE_SCHEMA_VERSION=currentSchemaVersion('convergence-record');
const values=convergenceValuePolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,{schemaVersion:CONVERGENCE_SCHEMA_VERSION});
export const {itemId,convergenceFacts,convergenceBindings,validateAdjudication,replacedAnswers,findingAdjudication,
  convergenceProjection,adjudicatedConvergenceProjection,assertConvergenceCandidateSource,renderConvergenceArtifact,
  assertConvergencePublishable,serializeConvergence}=values;

/** Preserve the installed command wording without putting shell syntax in portable rules. */
export function assertConvergenceIntegrity(record,options={}){
  try{return values.assertConvergenceIntegrity(record,options);}catch(error){
    if(error.code!=='CONVERGENCE_BINDINGS_STALE')throw error;
    throw new SingularityFlowError(
      'Convergence bindings no longer match the current approved inputs. Run singularity-flow story converge again before adjudicating or advancing.',
      {code:error.code,details:error.details});
  }
}

/** Parse and integrity-check stored bytes; malformed JSON is corruption, never absence. */
export function decodeConvergenceRecord(rawBytes, options = {}) {
  try {
    const record = readRecord('convergence-record', rawBytes).record;
    return assertConvergenceIntegrity(record, options);
  } catch (error) {
    if (String(error?.code ?? '').startsWith('CONVERGENCE_')) throw error;
    // A record written by a newer/archived compatible reader is unavailable to this build, not
    // corrupt. Preserve the registry's actionable version diagnosis in those two cases.
    if (['SCHEMA_VERSION_FUTURE', 'SCHEMA_VERSION_ARCHIVED'].includes(error?.code)) throw error;
    throw new SingularityFlowError(
      `Convergence record is corrupt: ${error?.message ?? String(error)}`,
      { code: 'CONVERGENCE_RECORD_CORRUPT', cause: error }
    );
  }
}

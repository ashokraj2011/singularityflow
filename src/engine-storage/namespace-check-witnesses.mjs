/** Pinned execution facts from an already verified check proof. No verdict, execution or writes. */
import {persistedOccurrences} from '../verification/test-report-reader.mjs';
export function namespaceWitnessAttempt(witness,found,repositoryId){
  const index=found?.plan.steps.findIndex(row=>row.repositoryId===repositoryId&&row.command.id===witness.commandId)??-1;
  if(index<0)return null;
  const out=found.body.results[index]?.candidate?.output,check=found.body.checks[index];
  return check?{attemptId:found.plan.input.operationId+':'+witness.commandId,status:check.status,
    exitCode:out?.process.status??null,terminal:out?.process.closed===true,timedOut:out?.process.timedOut===true,
    adapter:out?.reports.adapter,tests:check.tests,occurrences:persistedOccurrences(out?.reports.parsed)}:null;
}

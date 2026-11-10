/** Standing scope rules for retained supporting outputs. No source discovery, storage or approval. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {recordPathMatches} from '../foundation/record-shapes.mjs';
import {phaseInspectionGeneration,requiresProspectivePhaseInspection,phaseRequiresCodeDelivery} from './phase-policy.mjs';
export const PHASE_OUTPUT_LIMITS=Object.freeze({files:32,fileBytes:16*1024*1024,totalBytes:64*1024*1024});
export const phaseOutputPathKey=path=>path.toLowerCase();
const fail=(message,code='ENGINE_OUTPUT_SCOPE_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function phaseOutputSelection(definition,workflow,{phaseId,path}){
  const phase=workflow?.phases?.[phaseId],workId=workflow?.workItem?.id;
  if(workflow?.status!=='in_progress'||workflow.currentPhase!==phaseId||!phase||!requiresProspectivePhaseInspection(workflow,phase)
    ||!['artifact-only','source-and-artifact'].includes(phase.writeScope))fail(
      'Retain new output in the current open authoring generation; published output keeps its original record.',
      'ENGINE_OUTPUT_AUTHORING_REQUIRED',{actions:[{operation:'story.status',inputs:{workId}}]});
  const root=(definition.workItemRoot??'singularity/work-items')+'/'+workId+'/evidence/';
  if(typeof path!=='string'||path.length>512||!recordPathMatches(path,{windowsSegments:true})||!path.startsWith(root))fail(
    'Retain one exact portable output path inside this Story evidence directory.');
  const protectedPaths=[...(definition.governance?.protectedPaths??[]),...(workflow.resolution?.governance?.protectedPaths??[]),...(workflow.resolution?.capability?.policy?.protectedPaths??[])];
  if(protectedPaths.some(guard=>path.toLowerCase()===String(guard).toLowerCase()
    ||path.toLowerCase().startsWith(String(guard).replace(/\/$/u,'').toLowerCase()+'/')))fail(
      'Protected output needs its original authority. Retention cannot exempt a path.','ENGINE_OUTPUT_PROTECTED');
  return {workId,phase:phaseId,generation:phaseInspectionGeneration(workflow,phase),path,purpose:'supporting-evidence',
    sourceRequired:phaseRequiresCodeDelivery(phase)};
}

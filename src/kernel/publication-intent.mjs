/** Publication-operation policy; frequent phase/session reads need none of this operation's intent handling. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { effectivePhasePublicationProducer, normalizeAuthorshipOptions, assertProducerAllowed, isConvergencePhase,phaseRequiresCodeDelivery,stepResponsibilities } from './phase-policy.mjs';
import {approvedInputPhases} from './phase-inputs.mjs';

/** Resolve the same pinned producer defaults before any publication effect. */
export function publicationAuthorshipIntent(phase, input, { modelEnabled = true } = {}) {
  const implicit = effectivePhasePublicationProducer(phase, { modelEnabled });
  const authored = input.authored ?? (implicit === 'deterministic' ? 'deterministic' : null);
  const authorship = normalizeAuthorshipOptions({ producer: authored, channel: input.channel,
    imported: Boolean(input.from), externalAiUse: input.externalAiUse,
    changeOrigins: input.changeOrigins?.length ? input.changeOrigins : null });
  return Object.freeze({ authorship, legacyWarning: !input.authored && authored !== 'deterministic' });
}

export function assertPublicationAuthorshipIntent(phase, input, intent) {
  if (isConvergencePhase(phase) && input.from) {
    // Compatibility diagnostics remain exact; command rendering belongs to the host adapter.
    throw new SingularityFlowError('A deterministic convergence artifact cannot be imported.', {
      code: 'CONVERGENCE_ARTIFACT_KERNEL_OWNED', details: { phase: phase.id }
    });
  }
  if (input.from && !['human', 'external-tool'].includes(intent.authorship.producer)) {
    throw new SingularityFlowError('--from requires --authored human or --authored external-tool.', { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  if ((input.usageFile || input.usage != null) && intent.authorship.producer !== 'governed-agent') {
    throw new SingularityFlowError('--usage-json is valid only with --authored governed-agent. Manual and deterministic publication record model usage as not-invoked.');
  }
  assertProducerAllowed(phase, intent.authorship.producer);
}

/** Required policy owners for the initial portable primary-document profile. No caller readiness flags. */
export function primaryDocumentPublicationRequirements(workflow,phase,{definition={}}={}) {
  const resolved=workflow.resolution??{},pinned=resolved.phases?.find(item=>item.id===phase.id),required=new Set();
  const need=(id,condition)=>{if(condition)required.add(id);};
  const roles=resolved.obligationGraph?.nodes?.find(item=>item.id===phase.id)?.responsibilities;
  need('workflow-semantics',resolved.phaseSemantics?.profile!=='sflow-phase-semantics/v1');
  need('workflow-responsibility-policy',!Array.isArray(roles)||roles.length!==1||roles[0]!=='review');
  need('code-delivery',phase.writeScope==='source-and-artifact');
  need('artifact-set',Boolean(pinned?.artifactSet||phase.artifactSet||phase.surgicalReopen));
  need('specification-analysis',pinned?.specificationQuality?.mode!=='off'||pinned?.clarification?.markers?.mode!=='off');
  need('clarification-record',pinned?.clarification?.mode!=='off');
  need('specification-claims',resolved.spec?.mode!=='off'||resolved.spec?.coverage!=='off'||resolved.spec?.acceptance!=='off');
  need('planned-claims',resolved.plannedClaims?.mode!=='disabled');
  need('code-delivery-inputs',approvedInputPhases(workflow,phase).some(id=>phaseRequiresCodeDelivery(workflow.phases[id])));
  need('comparison-evidence',Object.keys(phase.comparison??{}).length>0);
  need('constitution-policy',resolved.constitution?.mode!=='off');
  need('check-execution',(phase.qualityCommands??[]).length>0);
  need('mcp-host',(phase.mcp?.requiredServers??[]).length>0||phase.mcp?.requireSmoke||(phase.mcp?.evidence??[]).length>0);
  need('world-model-grounding',resolved.worldModelGrounding!=='off');
  need('external-design-evidence',resolved.designSources!==null&&resolved.designSources!==undefined);
  need('test-recovery',resolved.testRecovery?.enabled===true);
  need('assignment-record',(resolved.collaboration??definition.collaboration)?.assignmentMode==='required'&&!workflow.collaboration?.assignments?.[phase.id]);
  need('model-assurance',resolved.codeDelivery?.model?.minimumAssurance!=='unavailable');
  need('signed-audit',(resolved.ledger??definition.ledger)?.signing!==undefined&&(resolved.ledger??definition.ledger)?.signing!=='off');
  need('architecture-intent',resolved.architectureIntent?.enabled===true);
  need('integration-receipts',(resolved.phases??[]).some(item=>(item.afterStep??[]).some(action=>action.required===true))||Boolean(workflow.pendingStepActions?.length));
  need('repair-journal',Boolean(workflow.phaseRepairs||workflow.phaseRepairJournal||workflow.phaseAppeals||workflow.phaseAppealDecisions));
  need('quality-risk-decisions',Boolean(workflow.qualityRiskDecisions?.length));
  need('document-risk',(workflow.documentRisks??[]).length>0||Boolean(workflow.documentRiskDecisions?.length));
  need('execution-origin',workflow.executionOrigin?.mode==='auto');
  need('test-command-amendment',Boolean(workflow.testCommandAmendments?.length));
  return Object.freeze([...required].sort());
}

/** Code evidence is a separate retained policy contract, not a primary-document exemption. */
export const CODE_PUBLICATION_OWNERS=Object.freeze(['workflow-responsibility-policy','code-delivery','specification-claims','planned-claims']);
export function codePublicationPolicy(workflow,phase){
  if(!phase)return null;
  const roles=stepResponsibilities(workflow,phase.id);
  if(!phaseRequiresCodeDelivery(phase)||phase.writeScope!=='source-and-artifact'
    ||workflow.resolution?.phaseSemantics?.profile!=='sflow-phase-semantics/v1'||workflow.resolution?.plannedClaims?.mode!=='required'
    ||workflow.resolution?.spec?.mode!=='enforce'||!roles.includes('implement')||!roles.includes('verify')
    ||roles.some(role=>!['implement','verify','review'].includes(role)))return null;
  return {profile:'sflow-namespace-code-policy/v1',owners:CODE_PUBLICATION_OWNERS};
}

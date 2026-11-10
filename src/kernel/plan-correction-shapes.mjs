/** Immutable plan/evidence correction values; authority and confirmation are admitted separately. */
import {freezeRecordShape} from '../foundation/record-shapes.mjs';
export function planCorrectionRecordShapes(){
const string=(minimum=1,maximum=null,trim=false)=>({kind:'string',minimum,maximum,trim}),regex=pattern=>({kind:'string',pattern}),object=fields=>({kind:'object',fields}),
  nullable=value=>({...value,nullable:true}),optional=value=>({...value,optional:true}),literal=value=>({kind:'literal',value}),
  sha=regex('^[a-f0-9]{64}$'),clause=regex('^[A-Z0-9][A-Z0-9._-]{0,63}:[A-Z]{2,4}-\\d{3}$'),fulfillment=regex('^[a-z][a-z-]{0,31}$'),
  portablePath={...string(1,512),path:{}},positive={kind:'integer',minimum:1,positive:true},datetime={kind:'datetime',allowMinutePrecision:true},
  operation=(op,fields)=>object({op:literal(op),clauseId:clause,...fields});
const row=object({id:regex('^PRC-\\d{3,}$'),kind:literal('plan-row-correction'),ownerPhase:string(),ownerGeneration:positive,ownerMapSha256:sha,
  operations:{kind:'array',minimum:1,maximum:20,item:{kind:'union',discriminator:'op',options:[
    operation('add-row',{claim:{kind:'record'}}),operation('set-fulfillment',{fulfillment,previousClaimSha256:sha}),
    ...['add-test','remove-test'].map(op=>operation(op,{test:portablePath,previousClaimSha256:sha})),
    operation('replace-test',{from:portablePath,to:portablePath,previousClaimSha256:sha}),
    operation('remove-location',{path:portablePath,previousClaimSha256:sha}),
    operation('replace-location',{from:portablePath,to:portablePath,previousClaimSha256:sha})]}},
  reason:string(20,1000,true),actor:string(),authorityGroup:string(),identityAssurance:nullable({kind:'string'}),authorizationId:{kind:'string',uuid:true},
  reviewAssurance:literal('live-terminal-exact-plan-review'),at:datetime,upstreamIssue:nullable(regex('^UPI-\\d{3,}$')),presence:optional({kind:'record'})});
const evidencePath={...string(1,512),path:{windowsSegments:true}},evidence=object({
  id:regex('^PEA-[a-f0-9]{24}$'),kind:literal('evidence-contract-correction'),ownerPhase:string(),ownerGeneration:positive,ownerMapSha256:sha,
  clauseId:regex('^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\\d{3}$'),previousClaimSha256:sha,path:evidencePath,method:{kind:'enum',values:['visual','inspection']},
  reason:string(20,1000,true),actor:string(),authorityGroup:string(),authorizationId:string(),
  reviewAssurance:{kind:'enum',values:['live-terminal-exact-evidence-review','live-local-ui-exact-evidence-review']},at:datetime,recordPath:evidencePath,
  reviewedFile:object({sha256:sha,size:{kind:'integer',minimum:0,maximum:16*1024*1024}}),testsWaived:literal(false),phaseApproved:literal(false),presence:optional({kind:'record'})});
const {authorizationId,reviewAssurance,presence,...namespaceFields}=row.fields,
  namespaceRow=object({schemaVersion:literal(1),format:literal('sflow-namespace-plan-row-correction/v1'),...namespaceFields,reviewContext:regex('^sha256:[a-f0-9]{64}$')});
return freezeRecordShape({row,evidence,portablePath,fulfillment,namespaceRow});
}

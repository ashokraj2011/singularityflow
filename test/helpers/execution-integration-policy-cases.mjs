/** Observe real policy APIs only; no host inventory, network, provider or delivery invocation. */
import * as mcp from '../../src/mcp.mjs';
import * as actions from '../../src/step-actions.mjs';
import * as auto from '../../src/auto/auto-policy.mjs';
import * as adhoc from '../../src/adhoc/policy.mjs';

export const policyModules={mcp,actions,auto,adhoc};
const servers={browser:{hostReference:'browser',agents:['tester'],phases:['verify'],tools:['open','capture'],required:true}};
const scope={agents:['tester'],phases:['draft','verify']};
const targets={targets:{events:{kind:'webhook',url:'https://events.example.test/sflow',signingSecret:'SFLOW_SECRET_EVENTS_KEY'}}};
const pinned=actions.normalizeIntegrations(targets);
const invocation={id:'notify',target:'events',on:['approved'],send:'event',required:true};
const cases=[
  ['auto','normalizeAutoPolicy',[]],['auto','normalizeAutoPolicy',[{enabled:true}]],
  ['auto','normalizeAutoPolicy',[{enabled:'yes'}]],['auto','normalizeAutoPolicy',[{unknown:true}]],
  ['auto','parseAutoPace',['phase']],['auto','parseAutoPace',['continuous']],['auto','parseAutoPace',['interval:30m']],
  ['auto','parseAutoPace',['interval:0m']],['auto','parseAutoPace',['unknown']],
  ['auto','normalizeAutoPolicy',[{execution:{allowPolicyWaivers:true}}]],
  ['auto','normalizeAutoPolicy',[{execution:{allowClarificationAnswers:true}}]],
  ['auto','parseAutoStopSelector',['verify',['draft','verify']]],
  ['auto','parseAutoStopSelector',['published:verify',['draft','verify']]],
  ['auto','parseAutoStopSelector',['published:missing',['draft','verify']]],
  ['auto','parseAutoStopSelector',['story-complete']],
  ['auto','normalizeAutoCeilings',[{maximumAuthoringAttemptsPerPhase:0}]],
  ['auto','normalizeAutoCeilings',[{tokenBudget:{maximum:2048,assurance:'best-available'}}]],
  ['auto','normalizeAutoWorkTypePolicy',[{eligibility:'bounded',defaultUntil:'phase-complete:verify'},'sample',['draft','verify']]],
  ['auto','normalizeAutoWorkTypePolicy',[{eligibility:'unlimited'}]],
  ['auto','normalizeCapabilityAutoPolicy',[{maximumTouchedPaths:2,ceilings:{maximumPhases:1}}]],
  ['auto','foldCapabilityAutoPolicy',[{eligibility:'plan-only',maximumTouchedPaths:4},{eligibility:'bounded',maximumTouchedPaths:20}]],
  ['auto','effectiveAutoPolicy',[{enabled:true,ceilings:{maximumTouchedPaths:6}},{eligibility:'bounded',ceilings:{maximumTouchedPaths:20}},{maximumTouchedPaths:3}]],
  ['auto','selectAutoProfile',[{},'story']],['auto','selectAutoProfile',[{},'sgos']],
  ['adhoc','normalizeAdhocPolicy',[]],['adhoc','normalizeAdhocPolicy',[{enabled:false}]],
  ['adhoc','normalizeAdhocPolicy',[{scope:{maximumTouchedResources:2}}]],
  ['adhoc','normalizeAdhocPolicy',[{scope:{maximumTouchedResources:0}}]],
  ['adhoc','normalizeAdhocPolicy',[{baseline:{requireExactRevision:false}}]],
  ['adhoc','normalizeAdhocPolicy',[{unknown:true}]],
  ['mcp','normalizeMcpServers',[]],['mcp','normalizeMcpServers',[servers,scope]],
  ['mcp','normalizeMcpServers',[servers,{agents:['author'],phases:['verify']}]],
  ['mcp','normalizeMcpServers',[{browser:{...servers.browser,tools:['other/tool']}},scope]],
  ['mcp','normalizeMcpSources',[{tools:['open'],resources:['docs://accepted/']}]],
  ['mcp','normalizeMcpSources',[{tools:[]}]],['mcp','normalizeMcpSources',[{unknown:['open']}]],
  ['mcp','mcpSourceAllowed',[{tools:['open'],resources:['docs://accepted/'],prompts:['draft']},'tool','open']],
  ['mcp','mcpSourceAllowed',[{tools:['open'],resources:['docs://accepted/'],prompts:['draft']},'tool','other']],
  ['mcp','normalizePhaseMcpPolicy',[]],
  ['mcp','normalizePhaseMcpPolicy',[{requiredServers:['browser']},{servers:mcp.normalizeMcpServers(servers,scope),phaseId:'verify'}]],
  ['mcp','normalizePhaseMcpPolicy',[{requiredServers:['missing']},{servers:mcp.normalizeMcpServers(servers,scope),phaseId:'verify'}]],
  ['mcp','normalizePhaseMcpPolicy',[{requiredServers:['browser'],requireSmoke:true,evidence:[{server:'browser',tool:'capture',minimum:1}]},{servers:mcp.normalizeMcpServers(servers,scope),phaseId:'verify'}]],
  ['mcp','normalizePhaseMcpPolicy',[{requiredServers:['browser']},{servers:mcp.normalizeMcpServers(servers,scope),phaseId:'draft'}]],
  ['mcp','normalizePhaseMcpPolicy',[{requiredServers:['browser'],evidence:[{server:'browser',tool:'other'}]},{servers:mcp.normalizeMcpServers(servers,scope),phaseId:'verify'}]],
  ['mcp','mcpImportOnly',[{sources:{tools:['open']},tools:[],agents:[]}]],
  ['mcp','mcpServersForContext',[{mcpServers:mcp.normalizeMcpServers(servers,scope)},{agent:'tester',phase:'verify'}]],
  ['mcp','mcpServersForContext',[{mcpServers:mcp.normalizeMcpServers(servers,scope)},{agent:'author',phase:'draft'}]],
  ['mcp','validateMcpAgentTools',[{mcpServers:mcp.normalizeMcpServers(servers,scope),agentCatalog:[{id:'tester',tools:['browser/*']}]}]],
  ['mcp','validateMcpAgentTools',[{mcpServers:mcp.normalizeMcpServers(servers,scope),agentCatalog:[{id:'tester',tools:['browser/open']}]}]],
  ['actions','normalizeIntegrations',[]],['actions','normalizeIntegrations',[targets]],
  ['actions','normalizeIntegrations',[{targets:{events:{kind:'unavailable'}}}]],
  ['actions','normalizeIntegrations',[{targets:{events:{kind:'webhook',url:'http://events.example.test'}}}]],
  ['actions','normalizeIntegrations',[{targets:{events:{kind:'webhook',url:'https://user:pass@events.example.test'}}}]],
  ['actions','normalizeIntegrations',[{targets:{events:{kind:'webhook',url:'https://events.example.test',token:'sample'}}}]],
  ['actions','normalizeIntegrations',[{targets:{events:{kind:'webhook',url:'https://events.example.test',signingSecret:'OTHER_TOKEN'}}}]],
  ['actions','normalizeStepActions',[[],pinned]],['actions','normalizeStepActions',[[invocation],pinned]],
  ['actions','normalizeStepActions',[[{...invocation,target:'missing'}],pinned]],
  ['actions','normalizeStepActions',[[{...invocation,on:['unreviewed']}],pinned]],
  ['actions','normalizeStepActions',[[invocation,invocation],pinned]],
  ['actions','pinStepActions',[[invocation],pinned]],
  ['actions','stepActionTriggers',['approval-requested',{status:'awaiting_approval'}]],
  ['actions','stepActionTriggers',['approval-requested',{status:'approved'}]],
  ['actions','stepActionTriggers',['phase-approved',{status:'in_progress'}]],
  ['actions','stepActionTriggers',['phase-rejected',{status:'approved'}]],
  ['actions','storyRequiresStepActions',[{resolution:{phases:[{afterStep:[invocation]}]}}]],
  ['actions','storyRequiresStepActions',[{resolution:{phases:[]}}]],
  ['actions','actionsForTrigger',[{afterStep:[invocation]},'approved']],
  ['actions','actionsForTrigger',[{afterStep:[invocation]},'submitted']]
];

export function executionIntegrationPolicyResults(){
  return cases.map(([family,name,args],id)=>{
    const input=structuredClone(args);
    try{const value=policyModules[family][name](...input);return {id,family,name,status:'returned',input,value:value===undefined?{$undefined:true}:value};}
    catch(error){return {id,family,name,status:'refused',input,error:{name:error.name,message:error.message,code:error.code??null,exitCode:error.exitCode??null,details:error.details??null}};}
  });
}

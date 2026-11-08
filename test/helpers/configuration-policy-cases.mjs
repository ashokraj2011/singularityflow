/** Pre-extraction policy observations exercise real native exports, without store or provider calls. */
import * as session from '../../src/session-policy.mjs';
import * as template from '../../src/template-catalog.mjs';
import * as repair from '../../src/repair-budget.mjs';
import * as intelligence from '../../src/intelligence-policy.mjs';
import * as task from '../../src/model-tasks.mjs';
import * as harness from '../../src/harness-import-policy.mjs';
import * as context from '../../src/context-policy.mjs';
import * as runtime from '../../src/test-runtime.mjs';
import * as tokens from '../../src/token-economy.mjs';
import * as delivery from '../../src/code-delivery-policy.mjs';
import * as spec from '../../src/specifications.mjs';
import * as documents from '../../src/document-storage-policy.mjs';

export const nativePolicyModules={session,template,repair,intelligence,task,harness,context,runtime,tokens,delivery,spec,documents};
const cases=[
  ['session','normalizeSessionPolicy',[]],['session','normalizeSessionPolicy',[{workItemSelection:'prompt',requireBeforeTools:true}]],
  ['session','normalizeSessionPolicy',[{requireBeforeTools:'yes'}]],['session','normalizeSessionPolicy',[{unexpected:true}]],
  ['template','normalizeTemplateCatalog',[]],['template','normalizeTemplateCatalog',[{example:'common/example.md'}]],
  ['template','normalizeTemplateCatalog',[{example:{label:'Example',path:'common/example.md',kind:'requirements'}}]],
  ['template','normalizeTemplateCatalog',[{example:'../outside.md'}]],['template','parseTemplateReference',['template:example']],
  ['template','parseTemplateReference',['template:Example']],['template','resolveTemplate',[{templates:{example:'common/example.md'}},'template:example']],
  ['template','resolveTemplate',[{templates:{}},'template:absent']],['template','resolveTemplate',[{},'agent:example/default']],
  ['template','templatePath',[{},'common/example.md']],['template','templateReferences',[{phases:{draft:{defaultTemplate:'common/example.md'}},workTypes:{sample:{templateOverrides:{draft:'common/example.md'}}}},'common/example.md']],
  ['repair','normalizeReworkLoops',[]],['repair','normalizeReworkLoops',[[{from:'check',to:'repair',maxAttempts:2}],{workTypeId:'sample',phases:['repair','check']}]],
  ['repair','normalizeReworkLoops',[[{from:'repair',to:'check',maxAttempts:2}],{phases:['repair','check']}]],
  ['repair','normalizeRepairBudget',[]],['repair','normalizeRepairBudget',[{maxAttempts:3,resetOnPhase:'scope'},{phaseId:'code',phases:['scope','code']}]],
  ['repair','normalizeRepairBudget',[{maxAttempts:0}]],['intelligence','normalizeWorkTypeIntelligence',[]],
  ['intelligence','normalizeWorkTypeIntelligence',[{ast:'required-context',agentBriefs:'required'}]],
  ['intelligence','normalizeWorkTypeIntelligence',[{ast:'silent'}]],['intelligence','astContextRequested',[{resolution:{intelligence:{ast:'off'}}}]],
  ['task','assertModelTask',['code']],['task','assertModelTask',['invent']],['task','mappedContractClasses',[]],
  ['task','taskForContractClass',['clarification-and-artifact',{intent:'questions',generationTask:'code'}]],
  ['task','taskForContractClass',['clarification-and-artifact',{intent:'artifact',generationTask:'code'}]],
  ['task','taskForContractClass',['unknown-class']],['harness','normalizeHarnessImports',[]],
  ['harness','normalizeHarnessImports',[{mode:'record',previewTextBytes:2048,totalEnvelopeBytes:8192}]],
  ['harness','normalizeHarnessImports',[{previewTextBytes:8192,totalEnvelopeBytes:8192}]],
  ['harness','normalizeHarnessImports',[{mode:'enforce',conformance:{verbatimRelay:'enforce'}}]],
  ['context','normalizeContextPolicy',[]],['context','normalizeContextPolicy',[{onApproval:'new',onRejection:'keep',phaseOverrides:{draft:'compact'}},{phaseIds:['draft']}]],
  ['context','normalizeContextPolicy',[{phaseOverrides:{missing:'new'}},{phaseIds:['draft']}]],
  ['context','normalizeContextPolicy',[{phaseBoundary:'new',onApproval:'keep'}]],['runtime','normalizeTestRuntime',[]],
  ['runtime','normalizeTestRuntime',[{nodeOptions:['--no-experimental-webstorage','--no-experimental-webstorage']}]],
  ['runtime','normalizeTestRuntime',[{nodeOptions:['--require=/outside']}]],['tokens','normalizeTokenEconomy',[]],
  ['tokens','normalizeTokenEconomy',[{mode:'observe',composer:'legacy-v1',profile:{maximumEstimatedPromptTokens:8192}}]],
  ['tokens','normalizeTokenEconomy',[{profile:{maxInputTokens:2048,maximumEstimatedPromptTokens:4096}}]],
  ['tokens','normalizeTokenEconomy',[{composer:'unknown'}]],['delivery','normalizeCodeDeliveryPolicy',[]],
  ['delivery','normalizeCodeDeliveryPolicy',[{tests:{minimumPassed:0}}]],['delivery','normalizeCodeDeliveryPolicy',[{generationBoundary:{requireBegin:false}}]],
  ['spec','normalizeSpecPolicy',[]],['spec','normalizeSpecPolicy',[{mode:'enforce',acceptance:'enforce'}]],
  ['spec','normalizeSpecPolicy',[{mode:'never'}]],['spec','normalizeSpecPolicy',[{limits:{maxClausesPerArtifact:0}}]],
  ['documents','documentStorageChoices',[]],['documents','documentStorageChoices',[{storage:{allowed:['git'],default:'git'}}]],
  ['documents','resolveDocumentStorage',[]],['documents','resolveDocumentStorage',['sharepoint']],
  ['documents','resolveDocumentStorage',['git',{storage:{allowed:['local']}}]],
  ['documents','assertDocumentStoragePolicy',[{allowed:['local'],default:'local'}]],
  ['documents','assertDocumentStoragePolicy',[{allowed:['local'],default:'git'}]]
];

export function configurationPolicyResults(){
  return cases.map(([family,name,args],index)=>{
    try {const value=nativePolicyModules[family][name](...structuredClone(args));return {id:index,family,name,status:'returned',value:value===undefined?{$undefined:true}:value};}
    catch(error){return {id:index,family,name,status:'refused',error:{name:error.name,code:error.code??null,exitCode:error.exitCode??null,message:error.message,details:error.details??null}};}
  });
}

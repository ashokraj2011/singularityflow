/** Observe native configuration declarations before extraction; no execution or storage calls. */
import * as analysis from '../../src/analysis-limits.mjs';
import * as branch from '../../src/story-branch-name.mjs';
import * as boundary from '../../src/source-boundary.mjs';
import * as logging from '../../src/logging.mjs';
import * as ledger from '../../src/ledger-config.mjs';
import * as storage from '../../src/initiative-config.mjs';
import * as removed from '../../src/removed-features.mjs';
import * as agent from '../../src/agent-document-parser.mjs';
import * as convergence from '../../src/convergence.mjs';
import * as tokens from '../../src/token-reporting-policy.mjs';
import * as delivery from '../../src/code-delivery-policy.mjs';

export const declarationModules = { analysis, branch, boundary, logging, ledger, storage, removed, agent, convergence, tokens, delivery };
const code = { id: 'repair-code', writeScope: 'source-and-artifact', generation: { task: 'code', requirement: 'required' } };
const cases = [
  ['analysis','analysisLimits',[]], ['analysis','analysisLimits',[null]],
  ['analysis','analysisLimits',[{maxClauses:42}]], ['analysis','analysisLimits',[{maxClauses:0}]],
  ['analysis','analysisLimits',[{unknown:1}]], ['analysis','analysisLimits',[[]]],
  ['branch','assertStoryBranchNaming',[]], ['branch','assertStoryBranchNaming',[{pattern:'feature/{id}-{title}'}]],
  ['branch','assertStoryBranchNaming',[{pattern:'feature/{title}'}]], ['branch','assertStoryBranchNaming',[{pattern:'{id}-{owner}'}]],
  ['branch','assertStoryBranchNaming',[{pattern:'{id}',extra:true}]], ['branch','assertStoryBranchNaming',['{id}']],
  ['boundary','normalizeSourceBoundary',[]], ['boundary','normalizeSourceBoundary',['test-automation','browser-check']],
  ['boundary','normalizeSourceBoundary',['unknown','browser-check']],
  ['logging','normalizeLogging',[]], ['logging','normalizeLogging',[null]],
  ['logging','normalizeLogging',[{level:'verbose',console:'quiet',maxBytes:8192,keep:2}]],
  ['logging','normalizeLogging',[{level:'unrecognized'}]], ['logging','normalizeLogging',[{maxBytes:12}]],
  ['logging','normalizeLogging',[{keep:21}]], ['logging','normalizeLogging',[{unknown:true}]],
  ['logging','normalizeLogLevel',['warning']], ['logging','normalizeLogLevel',['silent']],
  ['ledger','normalizeLedgerConfig',[]], ['ledger','normalizeLedgerConfig',[{enabled:true,branch:'proof-state',remote:'upstream',enforcement:'required'}]],
  ['ledger','normalizeLedgerConfig',[{trustTier:'T3',signing:'off'}]],
  ['ledger','normalizeLedgerConfig',[{trustTier:'T3',signing:'commit',configurationHistory:{autoClear:false,keepRecent:3}}]],
  ['ledger','normalizeLedgerConfig',[{enabled:'yes'}]], ['ledger','normalizeLedgerConfig',[{pinTransport:'unknown'}]],
  ['ledger','normalizeLedgerConfig',[{configurationHistory:{keepRecent:0}}]], ['ledger','normalizeLedgerConfig',[null]],
  ['storage','normalizeStorage',[]], ['storage','normalizeStorage',[{maxBytes:1024,allowedMimeTypes:['image/png'],providers:{archive:{type:'s3',bucket:'evidence',prefix:'/stories/'}}}]],
  ['storage','normalizeStorage',[{providers:{archive:{type:'artifactory',baseUrl:'https://artifacts.example.test/',repository:'evidence'}}}]],
  ['storage','normalizeStorage',[{providers:{archive:{type:'artifactory',baseUrl:'http://artifacts.example.test/',repository:'evidence'}}}]],
  ['storage','normalizeStorage',[{providers:{archive:{type:'unknown'}}}]],
  ['storage','normalizeStorage',[{defaultProvider:'missing'}]], ['storage','normalizeStorage',[{allowedMimeTypes:['text/plain','text/plain']}]],
  ['removed','disabledArchitectureIntent',[]],
  ['removed','dropRemovedSettings',[{architectureIntent:{enabled:true},worldModel:{knowledge:{enabled:true},sourceRoots:['src'],views:{},stateBranch:'proof'},
    phases:{draft:{worldModel:{depth:'full'}}},workTypes:{sample:{phaseOverrides:{draft:{worldModel:{depth:'brief'}}}}}}]],
  ['removed','dropRemovedSettings',[{worldModel:{remote:'upstream',sharedRoots:['shared'],excludedRoots:['build']}}]],
  ['removed','dropRemovedSettings',[null]],
  ['agent','isAgentTemplateReference',['agent:analyst/spec']], ['agent','isAgentTemplateReference',['templates/spec.md']],
  ['agent','parseAgentTemplateReference',['agent:analyst/spec']], ['agent','parseAgentTemplateReference',['unknown']],
  ['convergence','assertNoAutonomousConvergence',[{}]],
  ['convergence','assertNoAutonomousConvergence',[{generation:{producer:'agent'}}]],
  ['convergence','assertNoAutonomousConvergence',[{repeatUntil:'no-findings'}]],
  ['tokens','validateTokenReportingPolicy',[]],
  ['tokens','validateTokenReportingPolicy',[{mode:'exact-or-unavailable',pricing:{sample:{input:1,output:2,cachedInput:0}},premiumMultipliers:{sample:3}}]],
  ['tokens','validateTokenReportingPolicy',[{mode:'estimated'}]], ['tokens','validateTokenReportingPolicy',[{pricing:{sample:{input:-1}}}]],
  ['tokens','validateTokenReportingPolicy',[{premiumMultipliers:{sample:-1}}]], ['tokens','validateTokenReportingPolicy',[{pricing:{sample:{}}}]],
  ['delivery','stepOutputKind',[]], ['delivery','stepOutputKind',[{generation:{requirement:'none'}}]],
  ['delivery','stepOutputKind',[{generation:{task:'analyze'}}]], ['delivery','stepOutputKind',[code]],
  ['delivery','compiledSkillStep',[{kind:'skill'}]], ['delivery','compiledSkillStep',[code]],
  ['delivery','pinCodeDeliveryTask',[{...code,generation:{requirement:'required'}}]],
  ['delivery','pinCodeDeliveryTask',[{id:'note',generation:{task:'document'}}]],
  ['delivery','assertCodeDeliveryConfiguration',[code]],
  ['delivery','assertCodeDeliveryConfiguration',[{...code,writeScope:'artifact-only'}]],
  ['delivery','assertCodeDeliveryConfiguration',[{id:'note',writeScope:'artifact-only',generation:{task:'document'}}]]
];

export function configurationDeclarationResults() {
  return cases.map(([family,name,args],id) => {
    const input = structuredClone(args);
    try { const value = declarationModules[family][name](...input);
      return { id, family, name, status: 'returned', input, value: value === undefined ? { $undefined: true } : value }; }
    catch (error) { return { id, family, name, status: 'refused', input,
      error: { name: error.name, message: error.message, code: error.code ?? null, exitCode: error.exitCode ?? null, details: error.details ?? null } }; }
  });
}

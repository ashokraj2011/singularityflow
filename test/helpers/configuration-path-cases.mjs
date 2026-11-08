/** Observe native declaration values only; no process, filesystem, provider or repository operations. */
import * as scope from '../../src/source-scope.mjs';
import * as sourcePaths from '../../src/source-path-policy.mjs';
import * as location from '../../src/work-item-location.mjs';
import * as sets from '../../src/artifact-sets.mjs';
import * as ast from '../../src/ast-policy.mjs';
import * as faults from '../../src/fault-repair.mjs';
import * as constitution from '../../src/constitution.mjs';
import * as injection from '../../src/inject.mjs';
import * as commands from '../../src/external-command-policy.mjs';
import * as environment from '../../src/environment-declaration.mjs';
import * as recovery from '../../src/test-recovery-intake.mjs';
import * as documents from '../../src/trp-document-policy.mjs';
import * as selection from '../../src/test-selection-policy.mjs';
import * as util from '../../src/util.mjs';

export const pathModules = { scope, sourcePaths, location, sets, ast, faults, constitution, injection, commands, environment, recovery, documents, selection, util };
const artifactSet = { primary: 'report.md', members: [{ path: 'report.md', role: 'report', required: true }] };
const document = { id: 'notes', phaseId: 'draft', path: 'docs/notes.md', requiredSections: ['Overview'] };
const inventory = { phaseId: 'implementation', commandId: 'tests', dependencyScope: 'repository-and-node-builtins-only',
  tests: [{ id: 'test-1', path: 'test/example.test.mjs', name: 'approved behavior' }] };
const cases = [
  ['scope','normalizeSourceRoots',[]], ['scope','normalizeSourceRoots',[['src/','./lib','src','shared']]],
  ['scope','normalizeSourceRoots',[['../outside']]], ['scope','normalizeSourceRoots',[['src\\nested']]],
  ['scope','normalizeSourceRoots',[['src/**']]], ['scope','normalizeSourceRoots',[['/outside']]],
  ['scope','normalizeSourceRoots',[['C:/outside']]],
  ['scope','worldModelSourceScope',[{worldModel:{sourceRoots:['src'],sharedRoots:['shared'],sourceHashExcludedRoots:['legacy'],testConfigurationPaths:['package.json']}}]],
  ['scope','worldModelSourceScope',[{}]], ['scope','worldModelSourceScope',[{sourceRoots:['src'],sourceHashExcludedRoots:['.git']}]],
  ['sourcePaths','sourcePathPolicy',[{sourceHashExcludedRoots:['vendor','legacy'],testConfigurationPaths:['build/test-config.json']}]],
  ['sourcePaths','normalizeSourceHashExcludedRoots',[['src','SRC']]],
  ['sourcePaths','normalizeTestConfigurationPaths',[['./config.json']]],
  ['sourcePaths','normalizeTestConfigurationPaths',[['config/CON.json']]],
  ['sourcePaths','normalizeTestConfigurationPaths',[['singularity/workflow.yml']]],
  ['sourcePaths','isSeparatelyHashedTestInput',['legacy/item.js',{sourceHashExcludedRoots:['legacy']}]],
  ['location','normalizeWorkItemRoot',[]], ['location','normalizeWorkItemRoot',['./team/work/']],
  ['location','normalizeWorkItemRoot',['team//work']], ['location','normalizeWorkItemRoot',['C:\\outside']],
  ['location','normalizeWorkItemRoot',['../outside']], ['location','normalizeWorkItemRoot',['/outside']],
  ['sets','normalizeArtifactSets',[]], ['sets','normalizeArtifactSets',[{report:artifactSet}]],
  ['sets','normalizeArtifactSets',[{report:{...artifactSet,members:[{path:'../outside',role:'report'}]}}]],
  ['sets','normalizeArtifactSets',[{report:{...artifactSet,members:[{path:'report.md',role:'report',authority:'advisory',required:true}]}}]],
  ['sets','normalizeArtifactSets',[{report:{...artifactSet,primary:'missing.md'}}]],
  ['ast','normalizeAstPolicy',[]], ['ast','normalizeAstPolicy',[null]],
  ['ast','normalizeAstPolicy',[{enabled:false}]], ['ast','normalizeAstPolicy',[{enabled:true,sourceRoots:['src','shared']}]],
  ['ast','normalizeAstPolicy',[{unknown:true}]], ['ast','normalizeAstPolicy',[{sourceRoots:['../outside']}]],
  ['faults','normalizeFaultRepairPolicy',[]], ['faults','normalizeFaultRepairPolicy',[{maxAttempts:2,protectedPaths:['src/protected']}]],
  ['faults','normalizeFaultRepairPolicy',[{maxAttempts:0}]], ['faults','normalizeFaultRepairPolicy',[{protectedPaths:['../outside']}]],
  ['faults','normalizeFaultRepairPolicy',[{protectedPaths:['/outside']}]],
  ['constitution','constitutionPolicy',[]], ['constitution','constitutionPolicy',['enforce']],
  ['constitution','constitutionPolicy',[{mode:'enforce',path:'docs/constitution.md'}]],
  ['constitution','constitutionPolicy',[{mode:'enforce',path:'../outside'}]],
  ['constitution','constitutionPolicy',[{mode:'unknown'}]],
  ['constitution','constitutionPolicy',[{mode:'enforce',path:'docs\\constitution.md'}]],
  ['injection','validateInjectionDefinition',[{}]],
  ['injection','validateInjectionDefinition',[{worldModel:{injection:{rules:[{include:['facts/*.json'],when:{phase:['draft']}}]}},phases:{draft:{}}}]],
  ['injection','validateInjectionDefinition',[{worldModel:{injection:{rules:[{include:['../outside']}]}}}]],
  ['injection','validateInjectionDefinition',[{worldModel:{injection:{rules:[{include:['C:\\outside']}]}}}]],
  ['injection','validateInjectionDefinition',[{worldModel:{injection:{rules:[{include:['facts/*.json'],when:{phase:['missing']}}]}}}]],
  ['commands','normalizeExternalCommand',[{id:'tests',argv:['npm','test']}]],
  ['commands','normalizeExternalCommand',[{id:'tests',argv:['node','scripts/test.mjs'],cwd:'./tools/../project'}]],
  ['commands','normalizeExternalCommand',[{id:'tests',argv:['npm','test'],cwd:'../outside'}]],
  ['commands','normalizeExternalCommand',[{id:'tests',argv:['npm','test'],env:{TOKEN:'literal'}}]],
  ['commands','normalizeExternalCommand',[{id:'tests',argv:['node','--eval','console.log(1)']}]],
  ['commands','normalizeExternalCommand',['npm test']],
  ['environment','looksSecretName',['SFLOW_SECRET_SERVICE_KEY']], ['environment','looksSecretName',['APPLICATION_MODE']],
  ['environment','declarableEnvironmentVariable',['APPLICATION_MODE']], ['environment','declarableEnvironmentVariable',['PATH']],
  ['environment','declarableEnvironmentVariable',['SINGULARITY_FLOW_TEST']],
  ['recovery','normalizeTestRecoveryPolicy',[]], ['recovery','normalizeTestRecoveryPolicy',[{enabled:true}]],
  ['recovery','normalizeTestRecoveryPolicy',[{enabled:true,maxDistinctAutomaticAttempts:4}]],
  ['recovery','normalizeTestRecoveryPolicy',[{enabled:true,allowEvidenceReuse:true}]],
  ['recovery','normalizeTestRecoveryPolicy',[{enabled:true,enabledRiskCategories:['nonessential-document'],riskAuthorities:['reviewers'],documentObligations:[document]}]],
  ['recovery','normalizeTestRecoveryPolicy',[{enabled:true,enabledRiskCategories:['new-test-failure'],riskAuthorities:['reviewers'],allowEvidenceReuse:true,caseInventory:[inventory]}]],
  ['recovery','normalizeTestRecoveryPolicy',[{enabled:true,caseInventory:[{...inventory,adapter:'maven-surefire-junit-v1',dependencyScope:'repository-and-declared-runtime-only',runtime:{executableSha256:'sha256:'+'a'.repeat(64),dependencyRoots:['/runtime/dependencies']},tests:[{id:'test-1',path:'test/ExampleTest.java',name:'approvedBehavior',className:'example.ExampleTest'}]}]}]],
  ['recovery','normalizeTestRecoveryPolicy',[{enabled:true,caseInventory:[{...inventory,baselineMutableRoots:['src','src/nested']}]}]],
  ['documents','normalizeDocumentObligations',[[document]]], ['documents','normalizeDocumentObligations',[[{...document,path:'AGENTS.md'}]]],
  ['documents','normalizeDocumentObligations',[[{...document,path:'docs/../notes.md'}]]],
  ['selection','normalizeTestSelectionPath',['./test/example.test.mjs']],
  ['selection','normalizeTestSelectionPath',['test\\example.test.mjs']],
  ['selection','normalizeTestSelectionPath',['../outside']],
  ['util','posix',['src/nested/file.mjs']], ['util','posix',['src\\nested\\file.mjs']]
];

export function configurationPathResults(modules = pathModules) {
  return cases.map(([family,name,args],id) => {
    const input = structuredClone(args);
    try { const value = modules[family][name](...input);
      return { id, family, name, status: 'returned', input, value: value === undefined ? { $undefined: true } : value }; }
    catch (error) { return { id, family, name, status: 'refused', input,
      error: { name: error.name, message: error.message, code: error.code ?? null, exitCode: error.exitCode ?? null, details: error.details ?? null } }; }
  });
}

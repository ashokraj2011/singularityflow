/** Repository inspection and literal safeguards shared by Story and configuration requests. No CLI grammar. */
import {SingularityFlowError} from './foundation/failures.mjs';
import { TEST_COMMAND_ECOSYSTEMS } from "./engine-compatibility/node-configuration-path.mjs";

const usage=message=>new SingularityFlowError(message,{code:'TEST_SETUP_PROPOSAL_USAGE',details:{subjectKind:'configuration'}});

export async function inspectedTestCommand(root,{suggestionId:use,sourceRoots=[]}) {
  const {inspectRepositoryTestSetup}=await import('./repository-test-setup.mjs');
  const inspection=await inspectRepositoryTestSetup(root,{sourceRoots:sourceRoots.length?sourceRoots:['.']});
  const suggestion=inspection.suggestions.find(entry=>entry.id===use);
  if(suggestion)return suggestion;
  const written=inspection.instructionCandidates.find(entry=>entry.id===use);
  if(written?.command)return {...written.command,source:{kind:'instruction',file:written.source.file,line:written.source.line}};
  if(written)throw usage(`'${use}' (${written.source.file}:${written.source.line}) cannot be proposed as written: ${written.reason} Give the command in full.`);
  const ids=[...inspection.suggestions,...inspection.instructionCandidates.filter(entry=>entry.command)].map(entry=>entry.id);
  throw usage(`No suggestion is called '${use}'${ids.length?`; inspection suggested ${ids.join(', ')}`:''}. `
    +'Inspect with singularity-flow capability test-setup --source-root <DIRECTORY> --json, or give the command in full.');
}

export async function assertTestCommandEnvironment(env={}) {
  const {classifyVariable}=await import('./secret-looking.mjs');
  for(const [name,value] of Object.entries(env)) {
    if(classifyVariable(name,value).kind==='secret')throw new SingularityFlowError(
      `--env ${name} looks like it carries a secret, and workflow.yml never holds one. Declare it as a secret in `
        +'singularity/environments.yml, bind it on the machine that runs the tests, and link the command to that environment.',
      {code:'QUALITY_COMMAND_ENV_SECRET',details:{subjectKind:'configuration',name}});
  }
}

export async function assertTestCommandLiterals(command) {
  await assertTestCommandEnvironment(command.env??{});
  if(command.ecosystem!=null&&!TEST_COMMAND_ECOSYSTEMS.includes(command.ecosystem))throw usage(
    `--ecosystem takes the language the command tests: ${TEST_COMMAND_ECOSYSTEMS.join(', ')}. Leave it out to cover every file below the affected roots.`);
}

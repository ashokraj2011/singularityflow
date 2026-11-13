/** Real compilation from an installed SDK outside the source checkout. No model or CLI is involved. */
import assert from 'node:assert/strict';import {mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {createNodeCommandExecutionUnit,NODE_COMMAND_EXECUTION_PROFILE} from '@sdk-name@/testing/execution';
import {createAgentTaskContract} from '@sdk-name@/execution/node';
import {canonicalJson} from '@sdk-name@/specifications';
import {createSqliteContentStore} from '@sdk-name@/storage/sqlite-content';
const root=path.resolve('application');await mkdir(root);await writeFile(path.join(root,'valid.mjs'),'export const answer = 42;\n');
const database=new DatabaseSync(path.resolve('observed-content.db'));
const digest=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');
try{
  const content=createSqliteContentStore({database,binding:{kind:'shared'},create:true}),
    unit=await createNodeCommandExecutionUnit({id:'installed-compiler',root,projectId:'installed-project',repositoryId:'app',content,commandKind:'compile',
      command:{executable:process.execPath,executableSha256:'sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
        arguments:['--check','valid.mjs'],environment:{}},authorizeCommand:manifest=>manifest.manifestSha256}),
    contract=createAgentTaskContract({taskId:'installed-compile',processId:'installed-checks',instructionId:'compile',objective:'Check the exact application syntax.',
      acceptanceClauses:[],policySnapshotSha256:digest('policy'),programSha256:digest('program'),inputs:[],readScope:['repository:app'],writeScope:['repository:app'],
      forbiddenScope:['.git'],allowedDevices:[],environmentManifestSha256:digest({}),candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},
      requiredEvidence:['process-result'],budgets:{activeMinutes:1,modelInvocations:0,touchedResources:100},stopConditions:[],executionUnitManifestSha256:unit.descriptor().manifestSha256}),
    candidate=await unit.collect(await unit.start(contract));
  assert.equal(candidate.output.format,NODE_COMMAND_EXECUTION_PROFILE);assert.equal(candidate.output.process.status,0);
  assert.equal(candidate.output.reports.parsed,null);assert.equal(candidate.output.reports.adapter,null);assert.equal(candidate.output.source.unchanged,true);
}finally{database.close();}

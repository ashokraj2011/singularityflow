/** A real Git worktree and accepted source bytes; no fabricated control or lifecycle evidence. */
import {execFileSync} from 'node:child_process';
import {writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {namespacePreparationFixture} from './namespace-preparation-fixture.mjs';
import {pinnedLocalGit} from './pinned-local-git.mjs';
import {createNamespaceSourceEngine} from '../../src/engine-storage/namespace-source.mjs';
import {createNamespaceSourceRetentionEngine} from '../../src/engine-storage/namespace-source-retention.mjs';
import {createNamespaceSourceControlEngine} from '../../src/engine-storage/namespace-source-control.mjs';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../../src/sgos/filesystem-source-unit.mjs';
import {createNodeGitSourceControlReader} from '../../src/sgos/node-git-source-control-reader.mjs';
const binary=await pinnedLocalGit();
export async function namespaceSourceControlFixture(t,{backend='filesystem',configure=null,retain=true,extraRepository=false}={}){
  const f=await namespacePreparationFixture(t,{backend,code:true,configure});f.control.permissions.push('phase.source.retain');
  const git=(...args)=>execFileSync(binary.executable,args,{cwd:f.sourceRoot,encoding:'utf8',timeout:15_000,env:process.env}).trim();
  git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');git('config','core.ignorecase','false');
  await writeFile(path.join(f.sourceRoot,'old.txt'),Array.from({length:40},(_,i)=>'original line '+i).join('\n'));
  await writeFile(path.join(f.sourceRoot,'gone.js'),'export const gone = true;');git('add','app.js','old.txt','gone.js');git('commit','-qm','baseline');
  const baselineCommit=git('rev-parse','HEAD'),privateFolder=path.join(f.sourceRoot,'singularity/work-items',f.inputs.workId,'inputs');await mkdir(privateFolder,{recursive:true});
  const localDocument='LOCAL-UPLOADED-DOCUMENT-BODY-MUST-NOT-BE-SHARED';await writeFile(path.join(privateFolder,'upload.txt'),localDocument);
  const sources=[f.unit];let additional=null;
  if(extraRepository){const root=path.join(f.directory,'backend');await mkdir(root);await writeFile(path.join(root,'app.js'),'export const backend = 1;');
    const run=(...args)=>execFileSync(binary.executable,args,{cwd:root,env:process.env,encoding:'utf8'}).trim();
    run('init','-q','-b','main');run('config','user.name','Example fixture');run('config','user.email','fixture@example.test');run('add','app.js');run('commit','-qm','backend baseline');
    const unit=await createFilesystemSourceUnit({root,id:'backend-source',projectId:f.scope.projectId,repositoryId:'backend'});
    additional={root,unit,baselineCommit:run('rev-parse','HEAD')};sources.push(unit);
  }
  const options={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,
    sources,localRecords:f.localRecords,localContent:f.localContent};
  await createNamespaceSourceEngine(options).run('source.bind',{operationId:'bind-control-source',workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,
    repositories:sources.map(unit=>unit.descriptor.repositoryId),reason:'Bind the actual source used by the Git observation fixture.'});
  await f.make({sources}).run('phase.prepare');git('mv','old.txt','renamed.txt');await rm(path.join(f.sourceRoot,'gone.js'));
  await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 43;');await writeFile(path.join(f.sourceRoot,'new.js'),'export const newValue = true;');
  const sourceReader=await createFilesystemSourceContentReader({root:f.sourceRoot,id:'actual-source-content',source:f.unit.descriptor});options.sourceReaders=[sourceReader];
  if(additional){await writeFile(path.join(additional.root,'app.js'),'export const backend = 2;');
    options.sourceReaders.push(await createFilesystemSourceContentReader({root:additional.root,id:'backend-content',source:additional.unit.descriptor}));}
  const sourceInput={operationId:'retain-control-source',workId:f.inputs.workId,phaseId:'intake'},source=retain?await createNamespaceSourceRetentionEngine(options).run('phase.source.retain',sourceInput):null;
  const actualReader=await createNodeGitSourceControlReader({id:'actual-source-git',root:f.sourceRoot,source:f.unit.descriptor,baselineCommit,git:binary,authorizeCapture:()=>true});
  const captureControl={captures:0,hook:async()=>{}},controlReader={descriptor:actualReader.descriptor,async capture(...args){captureControl.captures++;const value=await actualReader.capture(...args);await captureControl.hook(captureControl.captures,value);return value;}};
  options.sourceControlReaders=[controlReader];
  if(additional)options.sourceControlReaders.push(await createNodeGitSourceControlReader({id:'backend-git',root:additional.root,source:additional.unit.descriptor,
    baselineCommit:additional.baselineCommit,git:binary,authorizeCapture:()=>true}));
  const make=extra=>createNamespaceSourceControlEngine({...options,...extra});
  return {...f,git,baselineCommit,localDocument,privateFolder,additional,options,sourceInput,source,actualReader,controlReader,captureControl,make,engine:make(),
    input:{operationId:'retain-controls',workId:f.inputs.workId,phaseId:'intake'}};
}

/** Qualify the actual packed artifact in hosts which have no SFlow source checkout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildEngineSdk } from '../scripts/build-engine-sdk.mjs';
import { ENGINE_OPERATIONS, ENGINE_HELPERS } from '../src/engine-sdk/index.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import {gitTagLineDeltas} from '../src/git-status-detail.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@singularity-flow/engine-sdk';
const child = (executable, args, options) => {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000, ...options });
  assert.equal(result.status, 0, [result.error?.message,result.stderr,result.stdout].filter(Boolean).join('\n'));
  return result.stdout;
};

test('the headless SDK tarball installs and runs outside the source checkout', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-engine-sdk-package-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = isolatedTestEnvironment(path.join(directory, 'machine'));
  const artifact = path.join(directory, 'package'), consumer = path.join(directory, 'consumer');
  await mkdir(artifact); await mkdir(consumer);
  for (const file of ['package.json', 'README.md']) await copyFile(path.join(root, 'packages/engine-sdk', file), path.join(artifact, file));
  const first = await buildEngineSdk({ outdir: path.join(artifact, 'dist') });
  await t.test('builds contain only owned sources and stable bytes across repeated staging directories', async () => {
    const second = await buildEngineSdk({ outdir: path.join(artifact, 'dist') });
    assert.deepEqual(first, second);
    assert.ok(first.sources.every(source => !path.isAbsolute(source) && !source.includes('..')));
    assert.deepEqual(first.operations.map(operation => operation.id), ENGINE_OPERATIONS.map(operation => operation.id));
    assert.deepEqual((await readdir(artifact)).sort(), ['README.md', 'dist', 'package.json']);
    const unknown = path.join(directory, 'unowned', 'dist'); await mkdir(unknown, { recursive: true });
    await writeFile(path.join(unknown, 'important.txt'), 'preserve');
    await assert.rejects(buildEngineSdk({ outdir: unknown }));
    assert.equal(await readFile(path.join(unknown, 'important.txt'), 'utf8'), 'preserve');
  });

  const archives = path.join(directory, 'archives'); await mkdir(archives);
  const npm = args => { const launch = resolvePlatformProcess('npm', args); return child(launch.executable, launch.arguments,
    { cwd: artifact, env, ...launch.spawnOptions }); };
  const packed = JSON.parse(npm(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', archives]))[0];
  await t.test('the archive has all declared exports and types and no source checkout or runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile(path.join(artifact, 'package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    for (const key of ['dependencies', 'scripts', 'bin', 'bundleDependencies', 'optionalDependencies']) assert.equal(Object.hasOwn(manifest, key), false);
    const names = new Set(packed.files.map(file => file.path));
    for (const entry of Object.values(manifest.exports)) {
      for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) assert.ok(names.has(file.slice(2)), file);
    }
    assert.ok(names.has('dist/build.json'));
    assert.ok([...names].every(file => ['package.json', 'README.md'].includes(file) || file.startsWith('dist/')));
    assert.ok([...names].every(file => !file.endsWith('.map') && !file.includes('node_modules') && !file.includes('/test/')));
  });

  await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const launch = resolvePlatformProcess('npm', ['install', path.join(archives, packed.filename), '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  child(launch.executable, launch.arguments, { cwd: consumer, env, ...launch.spawnOptions });
  const run = async (name, source, args = [], { emptyPath = true } = {}) => {
    await writeFile(path.join(consumer, name), source);
    return child(process.execPath, [name, ...args], { cwd: consumer, env: { ...env, ...(emptyPath ? { PATH: '' } : {}) } });
  };
  await t.test('core import and registered execution have zero infrastructure imports or implicit project discovery', async () => {
    await run('pure.mjs', `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { createHash } from 'node:crypto';
      const blocked = [];
      const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('node:')) { blocked.push(specifier); throw new Error('infrastructure import: ' + specifier); }
        return next(specifier, context);
      } });
      const sdk = await import('${packageName}');
      assert.equal(sdk.ENGINE_CONTRACT, 'sflow-engine/v1');
      const changes=await import('${packageName}/changes');
      assert.equal(changes.SOURCE_TEXT_DIFF_PROFILE,'sflow-source-text-hunks/v1');
      assert.deepEqual(changes.sourceTextHunks('one\\ntwo\\n','one\\nchanged\\n').hunks,[{beforeStart:2,beforeLines:1,afterStart:2,afterLines:1}]);
      assert.throws(()=>changes.sourceTextHunks('old','new',{maximumWork:1}),{code:'ENGINE_SOURCE_DIFF_LIMIT'});
      const sourceControl=await import('${packageName}/source-control');
      assert.equal(sourceControl.SOURCE_CONTROL_READER_CONTRACT,'sflow-source-control-reader/v1');
      assert.equal(sourceControl.SOURCE_CONTROL_LIMITS.maximumDurationMs,300000);
      assert.throws(()=>sourceControl.validateSourceControlReader({}),{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});
      let digestCalls=0;
      const changeCodec=changes.createRepositoryChangeSetCodec(Object.freeze({profile:changes.REPOSITORY_CHANGE_SET_VALUES,
        sha256Text:value=>{digestCalls++;return 'sha256:'+createHash('sha256').update(value).digest('hex');},compareUtf8:(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))}));
      assert.equal(digestCalls,0);assert.equal(Object.hasOwn(changeCodec,'parseRawDiff'),false);
      const retainedEntry=changeCodec.withEntryIdentity({oldPath:null,newPath:'src/value.js',status:'added'});
      const candidate={entries:[retainedEntry]},digest=changeCodec.repositoryChangeSetDigest(candidate);
      assert.equal(changeCodec.verifyRepositoryChangeSetIntegrity({...candidate,digest}).valid,true);
      const execution=await import('${packageName}/execution');
      assert.equal(execution.EXECUTION_UNIT_CONTRACT,'sflow-execution-unit/v1');
      assert.equal(execution.EXECUTION_UNIT_METHODS.length,8);
      assert.throws(()=>execution.captureExecutionUnit({}),error=>error instanceof sdk.SingularityFlowError&&error.code==='ENGINE_EXECUTION_UNIT_PORT_INVALID');
      const operational=await import('${packageName}/execution/storage');
      assert.equal(operational.SGOS_OPERATIONAL_STORE_SPI_VERSION,1);
      assert.equal(operational.SGOS_OPERATIONAL_STORE_METHODS.length,10);
      assert.equal(operational.SGOS_OPERATIONAL_STORE_CAPABILITIES.authorityEligible,false);
      const reports=await import('${packageName}/testing/reports');
      assert.equal(reports.TEST_REPORT_BYTE_SYNTAX,'sflow-test-report-bytes/v1');
      assert.equal(reports.TEST_REPORT_LIMITS.maximumFileBytes,16777216);
      const artifacts = await import('${packageName}/artifacts');
      assert.equal(artifacts.renderArtifactTemplateText('{{work.id}} {{phase.label}}',
        {id:'team-review',label:'Team review'},{id:'T-1'}),'T-1 Team review');
      assert.equal(artifacts.normalizeArtifactTemplateCompatibility('{{WORK_ID}}',{id:'T-1'}),'T-1');
      assert.throws(()=>artifacts.validateArtifactTemplateText('{{unsupported}}'),error=>error instanceof sdk.SingularityFlowError);
      const complete='# Result\\n\\n## Evidence\\nAn actual retained observation.\\n';
      const contentObservation=artifacts.artifactContentObservation(complete);
      const contentPhase={id:'custom-review',status:'in_progress',generation:0,requiredArtifact:{minimumBytes:20,
        validation:{requiredHeadings:['Evidence']}}};
      const fingerprint='sha256:'+createHash('sha256').update(contentObservation.fingerprintText).digest('hex');
      assert.deepEqual(artifacts.inspectRequiredArtifactObservation(contentObservation,contentPhase,{fingerprint}),[]);
      const unchanged=artifacts.inspectRequiredArtifactObservation(contentObservation,{...contentPhase,authoringBaseline:{generation:1,fingerprint}},{fingerprint});
      assert.equal(unchanged[0].code,'artifact.template.unchanged');
      assert.equal(artifacts.artifactBytesAreText(new TextEncoder().encode(complete)),true);
      assert.equal(artifacts.artifactBytesAreText(Uint8Array.from([0,255])),false);
      assert.ok(artifacts.inspectBinaryArtifactSize(2,contentPhase).some(row=>row.code==='artifact.binary.text-contract'));
      let calls = 0;
      const original = Object.freeze(new Error('trusted host unavailable'));
      const engine = sdk.createEngine({ ports: { publication: Object.fromEntries(
        ['load','retained','prepare','commit','finish'].map(stage => [stage, async () => { calls++; throw original; }])) } });
      for (const helper of Object.keys(sdk.ENGINE_HELPERS)) assert.equal(engine[helper].name, helper);
      await assert.rejects(engine.run('phase.publish', {root:'/other'}), {code:'ENGINE_INPUT_INVALID'});
      assert.equal(calls, 0);
      await assert.rejects(engine.publishPhase({}), error => error === original);
      assert.equal(calls, 1);
      const statusPort = {
        async load() { return {subject:{kind:'story',id:'example'},source:{kind:'namespace-snapshot',revision:'opaque-1'},
          workflow:{workItem:{id:'example'},status:'in_progress',currentPhase:'custom-review',phaseOrder:['custom-review'],
            phases:{'custom-review':{id:'custom-review',label:'Custom review',status:'in_progress',generation:0,artifacts:[],checks:[],approvals:[]}}}}; },
        async read(context) { return {workId:'example',source:context.source,publication:{state:'not-retained',commit:null,error:null}}; }
      };
      const status = sdk.createEngine({ports:{storyStatus:statusPort,storyGuide:{load:statusPort.load},
        storyNext:{async load(){return {...await statusPort.load(),observations:{modelEnabled:true}};}}}});
      const observation = await status.run('story.status',{workId:'example'});
      assert.equal(observation.manifest.currentPhase,'custom-review');
      const next = await status.run('story.next',{workId:'example'});
      assert.equal(next.manifest.contract,'sflow-next-steps/v1');
      assert.equal(next.manifest.actions[0].kind,'prepare-phase');
      assert.equal(next.effects.approvalRecorded,false);
      assert.equal(observation.manifest.authorityVerified,false);
      assert.equal(observation.manifest.inventoryComplete,true);
      const guide = await status.run('story.guide',{workId:'example'});
      assert.equal(guide.manifest.actions[0].kind,'prepare-phase');
      assert.equal(guide.manifest.actions[0].operation.id,'phase.prepare');
      assert.equal(guide.manifest.authorityGranted,false);
      assert.deepEqual(blocked, []);
      hooks.deregister();
      for (const specifier of ['${packageName}/src/index.mjs', '${packageName}/dist/index.mjs'])
        await assert.rejects(import(specifier), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    `);
  });
  await t.test('explicit filesystem and SQLite stores resume original receipts in a different host process', async () => {
    const source = `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { SingularityFlowError as MainError } from '${packageName}';
      import { SingularityFlowError as ErrorType } from '${packageName}/errors';
      import { namespaceScope } from '${packageName}/namespace';
      import { createFilesystemNamespaceStore } from '${packageName}/storage/filesystem';
      import { createSqliteNamespaceStore } from '${packageName}/storage/sqlite';
      assert.equal(MainError, ErrorType);
      assert.throws(() => namespaceScope({projectId:'../invalid'}), error => error instanceof ErrorType);
      const scope={projectId:'application'}, operation={operationId:'host-one',
        preconditions:[{namespace:'state',key:'stories/example',version:null}],
        changes:[{op:'put',namespace:'state',key:'stories/example',immutable:false,value:{kept:true}}],events:[]};
      const create=process.argv[3]==='create', directory=process.argv[2];
      for (const store of [await createFilesystemNamespaceStore({root:path.join(directory,'files'),binding:{kind:'shared'},create}),
        await createSqliteNamespaceStore({filename:path.join(directory,'records.sqlite'),binding:{kind:'shared'},create})]) {
        try {
          const committed=await store.transact(scope,operation);
          assert.equal(committed.replayed,!create);
          assert.deepEqual((await store.inspectOperation(scope,'host-one')).receipt,committed.receipt);
          assert.deepEqual((await store.read(scope,'state','stories/example')).record.value,{kept:true});
          await assert.rejects(store.transact(scope,{...operation,changes:[{...operation.changes[0],value:{kept:false}}]}),
            error => error instanceof ErrorType && error.outcomeClass==='OPERATION_ID_REUSE');
          assert.equal((await store.verify(scope)).valid,true);
        } finally { store.close?.(); }
      }
    `;
    const data = path.join(directory, 'data');
    await run('stores.mjs', source, [data, 'create']);
    await run('stores.mjs', source, [data, 'resume']);
  });
  await t.test('application ports and their reducer are packaged without an implicit database or authority', async () => {
    await run('application.mjs', `
      import assert from 'node:assert/strict';
      import { createApplicationNamespaceStore } from '${packageName}/storage/application';
      import { NAMESPACE_JOURNAL_PORT, emptyNamespaceState, applyNamespaceTransaction } from '${packageName}/storage/journal';
      const scope={projectId:'application'}, state=emptyNamespaceState();
      const tx={operationId:'example',preconditions:[{namespace:'state',key:'example',version:null}],
        changes:[{op:'put',namespace:'state',key:'example',value:{kept:true},immutable:false}],events:[]};
      assert.equal(applyNamespaceTransaction(state,scope,tx,{revision:'r1',requestDigest:'a'.repeat(64)}).receipt.operationId,'example');
      const original=Object.freeze(new Error('actual application timeout'));
      const journal={contract:NAMESPACE_JOURNAL_PORT,manifest:{storeId:'application',binding:{kind:'shared'},cursorKey:'a'.repeat(43)},
        async read(){throw original;},async append(){throw original;},async confirm(){throw original;}};
      const store=createApplicationNamespaceStore({id:'application',qualification:'test-only',binding:{kind:'shared'}},{journal});
      await assert.rejects(store.read(scope,'state','example'),error=>error===original);
      assert.equal(state.records.size,0,'pure reducer never commits the supplied state');
    `);
  });
  await t.test('installed namespace read hosts resume snapshots without source checkout or lifecycle permissions', async () => {
    const source = `
      import assert from 'node:assert/strict';
      import {mkdir} from 'node:fs/promises';
      import path from 'node:path';
      import {DatabaseSync} from 'node:sqlite';
      import {SingularityFlowError} from '${packageName}';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceReadEngine,namespaceStoryReadKey,projectNamespaceReadState,projectNamespaceLifecycleReadState,namespaceReadRecord} from '${packageName}/hosts/namespace-reader';
      const directory=process.argv[2],create=process.argv[3]==='create',terminal=process.argv[4]==='terminal';await mkdir(directory,{recursive:true});
      const db=new DatabaseSync(path.join(directory,'objects.db'));db.enableDefensive(true);db.enableLoadExtension(false);
      const scope={projectId:'headless-application'},workId='example',binding={kind:'shared'};
      const records=await createFilesystemNamespaceStore({root:path.join(directory,'records'),binding,create});
      const content=createSqliteContentStore({database:db,binding,create});
      try{
        if(create){
          const body=Buffer.from('Retained custom-phase output.\\n'),artifact=(await content.put(scope,'evidence',body)).reference;
          const sourceKey='singularity/work-items/example/artifacts/custom/summary.md';
          const workflow={workItem:{id:workId,branch:'team/branch'},status:terminal?'closed':'in_progress',currentPhase:terminal?null:'custom',phases:{custom:{id:'custom',generation:1,status:terminal?'approved':'in_progress',
            requiredArtifact:{path:'artifacts/custom/summary.md',kind:'custom-report'},artifacts:[{path:sourceKey,sha256:artifact.sha256,size:artifact.bytes}],agentBriefs:[]}}};
          const state=terminal?projectNamespaceLifecycleReadState(workflow):projectNamespaceReadState(workflow),policy=namespaceReadRecord('policy',{workItemRoot:'singularity/work-items',maximumPreviewBytes:1048576});
          assert.equal(state.schemaVersion,terminal?2:1);assert.equal(Object.hasOwn(state,'status'),terminal);
          const documents=namespaceReadRecord('documents',{documents:[{id:'PHASE-CUSTOM',phase:'custom',generation:1,sourceKey,role:'artifact',name:null,
            kind:'custom-report',mimeType:'text/markdown',encoding:'utf8',locality:'project',status:'active',aliases:[],content:artifact}]});
          const json=async(namespace,value)=>(await content.put(scope,namespace,Buffer.from(JSON.stringify(value)+'\\n'))).reference;
          const head=namespaceReadRecord('head',{projectId:scope.projectId,workId,state:await json('state',state),policy:await json('config',policy),documents:await json('state',documents)});
          const key=namespaceStoryReadKey(workId);
          await records.transact(scope,{operationId:'fixture-read-head',preconditions:[{namespace:'state',key,version:null}],
            changes:[{op:'put',namespace:'state',key,immutable:false,value:head}],events:[]});
        }
        const engine=createNamespaceReadEngine({records,content,scope,workId});
        const review=await engine.run('phase.review',{phaseId:'custom'});assert.equal(review.manifest.integrity,'matched');
        assert.equal(review.manifest.reviewBinding,null);
        const read=await engine.run('document.read',{reference:review.manifest.items[0].reference});
        assert.equal(read.document.content.text,'Retained custom-phase output.\\n');
        if(terminal)await assert.rejects(engine.run('phase.review'),error=>error.code==='ENGINE_PHASE_SELECTION_REQUIRED'
          &&error.details.actions.some(action=>action.operation==='phase.review'&&action.inputs.phaseId==='custom'));
        await assert.rejects(engine.approvePhase({}),error=>error instanceof SingularityFlowError&&error.code==='ENGINE_PORT_UNAVAILABLE');
      }finally{db.close();}
    `;
    const data = path.join(directory, 'namespace-data');
    await run('reader.mjs', source, [data, 'create']); await run('reader.mjs', source, [data, 'resume']);
    const closed = path.join(directory, 'terminal-namespace-data');
    await run('reader.mjs', source, [closed, 'create', 'terminal']); await run('reader.mjs', source, [closed, 'resume', 'terminal']);
  });
  await t.test('an installed host enrolls a new project and replays the receipt in another empty-PATH process', async () => {
    const source = `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { createFilesystemNamespaceStore } from '${packageName}/storage/filesystem';
      import { createSqliteContentStore } from '${packageName}/storage/sqlite-content';
      import { createNamespaceProjectEngine } from '${packageName}/hosts/namespace-project';
      const binding={kind:'shared'},scope={projectId:'portable-project'},fresh=process.argv[2]==='fresh';
      const records=await createFilesystemNamespaceStore({root:path.resolve('enrollment-records'),binding,create:fresh});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('enrollment-content.db'));
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const content=createSqliteContentStore({database,binding,create:fresh});
      try {
        let accessCalls=0,clockCalls=0;
        const access={current(){accessCalls++;if(!fresh)throw new Error('replay cannot authorize a new effect');
          return {projectId:scope.projectId,principalId:'application-owner',permissions:['project.enroll']};}};
        const clock={now(){clockCalls++;if(!fresh)throw new Error('replay cannot restamp intent');return '2026-11-08T00:00:00.000Z';}};
        const engine=createNamespaceProjectEngine({records,content,scope,authority:{id:'application-authority',epoch:1},access,clock});
        const result=await engine.run('project.enroll',{operationId:'portable-enrollment'});
        assert.equal(result.replayed,!fresh);assert.equal(result.recordedAt,'2026-11-08T00:00:00.000Z');
        assert.equal(result.effects.configurationApproved,false);assert.equal(result.effects.storyCreated,false);
        assert.equal(accessCalls,fresh?2:0);assert.equal(clockCalls,fresh?1:0);
        assert.equal((await records.list(scope,'state',{limit:100})).entries.length,1);
        process.stdout.write(JSON.stringify(result));
      } finally {database.close();}
    `;
    const first = JSON.parse(await run('enrollment.mjs', source, ['fresh']));
    const replay = JSON.parse(await run('enrollment.mjs', source, ['replay']));
    assert.deepEqual(replay, { ...first, replayed: true });
  });

  await t.test('an installed configuration host approves and reopens real content in empty-PATH processes',async()=>{
    const source=`
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import {readFile,writeFile} from 'node:fs/promises';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceProjectEngine} from '${packageName}/hosts/namespace-project';
      import {createNamespaceConfigurationEngine,NAMESPACE_CONFIGURATION_HEAD_KEY} from '${packageName}/hosts/namespace-configuration';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1};
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding,create:fresh});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding,create:fresh});
      try {
        let calls=0;const access={current(){calls++;if(!fresh)throw Error('a retained approval cannot authorize a new effect');
          return {projectId:scope.projectId,principalId:'human-reviewer',permissions:['project.enroll','configuration.approve'],actorKind:'human'};}};
        const clock={now(){if(!fresh)throw Error('a retained decision cannot be restamped');return '2026-11-08T00:00:00.000Z';}};
        let inputs;
        if(fresh){
          await createNamespaceProjectEngine({records,content,scope,authority,access,clock}).run('project.enroll',{operationId:'enroll'});
          const text=async value=>(await content.put(scope,'config',Buffer.from(value))).reference;
          const body=await text('Apply the verified requirements and retain evidence.\\n');
          const packet={schemaVersion:1,format:'sflow-namespace-configuration-source/v1',
            definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',phases:{intake:{label:'Intake',artifact:{path:'artifacts/intake/plan.md'},defaultTemplate:'intake.md',approval:{authorities:['reviewers'],minimum:1,rejectTo:['intake']}}},
              approvalAuthorities:{reviewers:{members:[{email:'reviewer@example.test'},{email:'independent@example.test'}]}},
              workTypes:{simple:{label:'Simple',phases:['intake'],
                omits:['scope','plan','implement','verify'].map(responsibility=>({responsibility,reason:'This workflow produces a reviewed document, without delivering application behavior.',authority:'reviewers'}))}}},
            agents:[{id:'analyst',label:'Analyst',phases:['intake'],defaultFor:['intake'],mode:'read-write',body,skills:[],instructions:[]}],
            skills:[],instructions:[],templates:[{path:'singularity/templates/intake.md',body}],files:[]};
          packet.definition.workTypes.routing={...structuredClone(packet.definition.workTypes.simple),label:'Routed review',decisions:[{
            id:'channel',label:'Channel',after:'intake',kind:'branch',inputs:[{name:'channel',values:['Web','Mobile']}],
            routes:['web','mobile'].map((id,index)=>({id,label:id,...(index===0?{when:{channel:'Web'}}:{}),to:'end',
              omits:structuredClone(packet.definition.workTypes.simple.omits)}))}]};
          packet.definition.workTypes.choice={...structuredClone(packet.definition.workTypes.simple),label:'Human direction',decisions:[{
            id:'direction',label:'Choose the reviewed direction',after:'intake',kind:'ask',
            routes:['deliver','withdraw'].map(id=>({id,label:id,to:'end',omits:structuredClone(packet.definition.workTypes.simple.omits)}))}]};
          const reference=await text(JSON.stringify(packet));
          inputs={operationId:'approve-configuration',source:reference,expectedRevision:null,confirm:reference.sha256,reason:'Reviewed the complete workflow package.'};
          await writeFile('configuration-inputs.json',JSON.stringify(inputs));
        }else inputs=JSON.parse(await readFile('configuration-inputs.json','utf8'));
        const engine=createNamespaceConfigurationEngine({records,content,scope,authority,access,clock});
        const result=await engine.run('configuration.approve',inputs);
        const head=await records.read(scope,'config',NAMESPACE_CONFIGURATION_HEAD_KEY);
        assert.equal(result.replayed,!fresh);assert.equal(result.revision,head.record.version);assert.equal(result.effects.configurationApproved,true);
        const compiled=JSON.parse(Buffer.from((await content.read(scope,result.configuration)).data).toString('utf8'));
        assert.deepEqual(compiled.workTypeIds,['simple','routing','choice']);assert.equal(compiled.definition.agentCatalog[0].id,'analyst');
        assert.equal(compiled.workflows.simple.phases[0].defaultAgent,'analyst');
        assert.equal((await content.read(scope,compiled.agents[0].body)).status,'present');
        if(!fresh)assert.equal(calls,0);
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();}
    `;
    const first=JSON.parse(await run('configuration.mjs',source,['fresh']));
    const replay=JSON.parse(await run('configuration.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,replayed:true});
  });

  await t.test('installed Story creation pins real configuration and reopens its source in a separate empty-PATH process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {readFile,writeFile} from 'node:fs/promises';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceStoryEngine} from '${packageName}/hosts/namespace-story';
      import {createNamespaceReadEngine} from '${packageName}/hosts/namespace-reader';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='portable-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding});
      try {
        let calls=0;const access={async current(){calls++;if(!fresh)throw Error('an accepted creation cannot authorize another effect');
          return {projectId:scope.projectId,principalId:'story-creator',permissions:['story.create'],actorKind:'human',identity:{name:'Example reviewer',email:'reviewer@example.test'}};}};
        const clock={now(){if(!fresh)throw Error('a retained creation cannot be restamped');return '2026-11-08T12:00:00.000Z';}};
        let inputs;
        if(fresh) {const reference=(await content.put(scope,'state',Buffer.from('# Source\\n\\nCreate a portable Story.\\n'))).reference;
          inputs={operationId:'create-portable-story',workId,title:'Portable Story',workTypeId:'simple',configurationId:'approve-configuration',source:reference};
          await writeFile('story-inputs.json',JSON.stringify(inputs));
        }else inputs=JSON.parse(await readFile('story-inputs.json','utf8'));
        const engine=createNamespaceStoryEngine({records,content,scope,workId,authority,access,clock});
        const created=await engine.run('story.create',inputs);
        assert.equal(created.replayed,!fresh);assert.equal(created.effects.approvalRecorded,false);assert.equal(created.generation,0);
        const reader=createNamespaceReadEngine({records,content,scope,workId});
        const document=await reader.run('document.read',{reference:created.source});
        assert.equal(document.document.content.text,'# Source\\n\\nCreate a portable Story.\\n');
        assert.equal(document.document.expected.sha256,inputs.source.sha256);
        if(!fresh)assert.equal(calls,0);
        process.stdout.write(JSON.stringify(created));
      }finally{database.close();}
    `;
    const first=JSON.parse(await run('story.mjs',source,['fresh']));
    const replay=JSON.parse(await run('story.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,replayed:true});
  });

  await t.test('the installed SDK binds a real checkout without Git and acknowledges its source receipt on reopening',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {mkdir,writeFile,readFile} from 'node:fs/promises';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceReadEngine} from '${packageName}/hosts/namespace-reader';
      import {createNamespaceSourceEngine} from '${packageName}/hosts/namespace-source';
      import {createFilesystemSourceUnit} from '${packageName}/sources/filesystem';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='portable-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding}),root=path.resolve('source-checkout');
      try {
        let calls=0;const access={current(){calls++;if(!fresh)throw Error('a retained baseline cannot authorize another effect');
          return {projectId:scope.projectId,principalId:'source-coordinator',actorKind:'human',permissions:['source.bind'],identity:{name:'Example coordinator',email:'coordinator@example.test'}};}};
        const clock={now(){if(!fresh)throw Error('an original source receipt cannot be restamped');return '2026-11-08T12:01:00.000Z';}};
        let inputs,sources=[];
        if(fresh) {
          await mkdir(root);await writeFile(path.join(root,'app.js'),'export const answer = 42;\\n');
          sources=[await createFilesystemSourceUnit({root,id:'portable-checkout',projectId:scope.projectId,repositoryId:'app'})];
          const read=createNamespaceReadEngine({records,content,scope,workId});
          const current=await read.run('phase.review',{phaseId:'intake'});
          assert.equal(typeof current.manifest.observedRevision,'string');
          inputs={operationId:'bind-portable-source',workId,expectedRevision:current.manifest.observedRevision,repositories:['app'],reason:'Bind the actual application checkout.'};
          await writeFile('source-inputs.json',JSON.stringify(inputs));
        }else {inputs=JSON.parse(await readFile('source-inputs.json','utf8'));await writeFile(path.join(root,'app.js'),'a later source edit');}
        const engine=createNamespaceSourceEngine({records,content,scope,workId,authority,sources,access,clock});
        const result=await engine.run('source.bind',inputs);
        assert.equal(result.replayed,!fresh);assert.equal(result.effects.sourceFilesChanged,false);assert.equal(result.effects.generationOpened,false);
        const manifest=JSON.parse(Buffer.from((await content.read(scope,result.repositories[0].snapshot)).data));
        assert.equal(manifest.entries[0].path,'app.js');assert.equal(manifest.provider,'filesystem');
        assert.equal(JSON.stringify(manifest).includes(root),false);if(!fresh)assert.equal(calls,0);
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();}
    `;
    const first=JSON.parse(await run('source.mjs',source,['fresh']));
    const replay=JSON.parse(await run('source.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,replayed:true});
  });

  await t.test('installed private preparation preserves authored bytes and original write receipts in another empty-PATH process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {readFile,writeFile} from 'node:fs/promises';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespacePreparationEngine} from '${packageName}/hosts/namespace-preparation';
      import {createNamespaceSourceInspectionEngine} from '${packageName}/hosts/namespace-source-inspection';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},privateBinding={kind:'machine-local',deviceId:'portable-device'};
      const scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='portable-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const localRecords=await createFilesystemNamespaceStore({root:path.resolve('private-records'),binding:privateBinding,create:fresh});
      const {DatabaseSync}=await import('node:sqlite');
      const sharedDatabase=new DatabaseSync(path.resolve('configuration-content.db')),privateDatabase=new DatabaseSync(path.resolve('private-content.db'));
      const content=createSqliteContentStore({database:sharedDatabase,binding});
      const localContent=createSqliteContentStore({database:privateDatabase,binding:privateBinding,create:fresh});
      try {
        const access={current:()=>({projectId:scope.projectId,principalId:'human-reviewer',actorKind:'human',
          identity:{name:'Example reviewer',email:'reviewer@example.test'},agentId:'analyst',
          permissions:['phase.prepare','phase.draft.read','phase.draft.write','phase.draft.rebase','phase.source.inspect']})};
        const clock={now(){if(!fresh)throw Error('Reopening an authored draft must not restamp its preparation or write.');return '2026-11-08T13:00:00.000Z';}};
        const engine=createNamespacePreparationEngine({records,content,localRecords,localContent,scope,workId,authority,access,clock});
        const before=await engine.run('phase.review',{phaseId:'intake'});
        const preparation=await engine.run('phase.prepare',{workId,phaseId:'intake'});
        assert.equal(preparation.effects.committed,false);assert.equal(preparation.effects.generationOpened,false);
        const draft=await engine.run('phase.draft.read');
        let input;
        if(fresh) {
          const reference=(await localContent.put(scope,'local',Buffer.from('# Authored intake\\n\\nAn observable requirement.\\n'))).reference;
          input={operationId:'author-intake',workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
            content:reference,reason:'Complete the retained private draft.'};
          await writeFile('private-draft-inputs.json',JSON.stringify(input));
        }else input=JSON.parse(await readFile('private-draft-inputs.json','utf8'));
        const result=await engine.run('phase.draft.write',input);
        assert.equal(result.replayed,!fresh);assert.equal(result.effects.committed,false);
        assert.equal((await engine.run('phase.draft.read')).manifest.artifact.content.text,'# Authored intake\\n\\nAn observable requirement.\\n');
        const after=await engine.run('phase.review',{phaseId:'intake'});
        assert.deepEqual(after,before,'private authoring cannot create a shared generation or move the canonical revision');
        const inspected=await createNamespaceSourceInspectionEngine({records,content,localRecords,localContent,scope,workId,authority,access,clock})
          .run('phase.source.inspect',{maximumEntries:0});
        assert.equal(inspected.manifest.status,'not-code-generation');assert.equal(inspected.effects.committed,false);
        assert.equal(JSON.stringify(result).includes(path.resolve('private-records')),false);
        process.stdout.write(JSON.stringify(result));
      }finally{sharedDatabase.close();privateDatabase.close();}
    `;
    const first=JSON.parse(await run('preparation.mjs',source,['fresh']));
    const replay=JSON.parse(await run('preparation.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,replayed:true});
  });

  await t.test('an installed code-generation reader compares actual files and reopens from another empty-PATH process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceEngine} from '${packageName}/hosts/namespace-engine';
      import {createNamespaceSourceInspectionEngine} from '${packageName}/hosts/namespace-source-inspection';
      import {createNamespaceSourceRetentionEngine} from '${packageName}/hosts/namespace-source-retention';
      import {createNamespaceSourceBaselineEngine} from '${packageName}/hosts/namespace-source-baseline';
      import {createNamespaceDeliveryInspectionEngine} from '${packageName}/hosts/namespace-delivery-inspection';
      import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '${packageName}/sources/filesystem';
      const fresh=process.argv[2]==='fresh',scope={projectId:'inspection-project'},workId='code-story',authority={id:'inspection-authority',epoch:1};
      const binding={kind:'shared'},privateBinding={kind:'machine-local',deviceId:'inspection-device'};
      const records=await createFilesystemNamespaceStore({root:path.resolve('inspection-records'),binding,create:fresh});
      const localRecords=await createFilesystemNamespaceStore({root:path.resolve('inspection-local-records'),binding:privateBinding,create:fresh});
      const database=new DatabaseSync('inspection-content.db'),privateDatabase=new DatabaseSync('inspection-local-content.db');
      const content=createSqliteContentStore({database,binding,create:fresh}),localContent=createSqliteContentStore({database:privateDatabase,binding:privateBinding,create:fresh});
      const clock={now(){if(!fresh)throw Error('Source inspection cannot restamp a generation.');return '2026-11-09T01:00:00.000Z';}};
      const access={current:()=>({projectId:scope.projectId,principalId:'reader',actorKind:'human',agentId:'analyst',
        identity:{name:'Example reviewer',email:'reviewer@example.test',login:null},
        permissions:fresh?['project.enroll','configuration.approve','story.create','source.bind','source.baseline.retain','phase.prepare','phase.source.inspect','phase.source.retain']:['phase.source.inspect']})};
      try{
        const root=path.resolve('inspection-checkout');if(fresh){await mkdir(root);await writeFile(path.join(root,'app.js'),'export const answer = 42;');}
        const unit=await createFilesystemSourceUnit({root,id:'application-checkout',projectId:scope.projectId,repositoryId:'app'});
        const common={records,content,scope,workId,authority,access,clock,sources:[unit]};
        if(fresh){
          const engine=createNamespaceEngine({...common,working:{records:localRecords,content:localContent}});
          await engine.run('project.enroll',{operationId:'enroll-inspection'});
          const text=async value=>(await content.put(scope,'config',Buffer.from(value))).reference,body=await text('# Implementation summary');
          const packet={schemaVersion:1,format:'sflow-namespace-configuration-source/v1',definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',
            phases:{delivery:{label:'Custom delivery',generation:{producer:'governed-agent',task:'code'},writeScope:'source-and-artifact',
              artifact:{path:'artifacts/delivery/summary.md',kind:'implementation-summary'},defaultTemplate:'summary.md',approval:{authorities:['reviewers'],minimum:1,rejectTo:['delivery']}}},
            approvalAuthorities:{reviewers:{members:[{email:'reviewer@example.test'}]}},workTypes:{custom:{label:'Custom code generation',phases:['delivery'],
              omits:['scope','plan','verify'].map(responsibility=>({responsibility,reason:'An isolated code-generation reader fixture.',authority:'reviewers'}))}}},
            agents:[{id:'analyst',label:'Analyst',phases:['delivery'],defaultFor:['delivery'],mode:'read-write',body,skills:[],instructions:[]}],
            skills:[],instructions:[],templates:[{path:'singularity/templates/summary.md',body}],files:[]};
          const configuration=await text(JSON.stringify(packet));
          await engine.run('configuration.approve',{operationId:'approve-code-config',source:configuration,expectedRevision:null,confirm:configuration.sha256,reason:'Review the custom code phase.'});
          const storySource=(await content.put(scope,'state',Buffer.from('Observe the source change without claiming publication.'))).reference;
          const story=await engine.run('story.create',{operationId:'create-code-story',workId,title:'Inspect a real generation',workTypeId:'custom',configurationId:'approve-code-config',source:storySource});
          await engine.run('source.bind',{operationId:'bind-code-source',workId,expectedRevision:story.revision,repositories:['app'],reason:'Retain the real generation baseline.'});
          const sourceReader=await createFilesystemSourceContentReader({root,id:'installed-baseline-reader',source:unit.descriptor,maximumChunkBytes:4});
          const baseline=await createNamespaceSourceBaselineEngine({...common,sourceReaders:[sourceReader]}).run('source.baseline.retain',{
            operationId:'retain-baseline-bytes',workId,sourceBindingId:'bind-code-source'});
          assert.equal(baseline.totals.files,1);assert.equal(baseline.baselineContentsRetained,true);
          await writeFile('retained-baseline-record.json',JSON.stringify(baseline.record));
          await engine.run('phase.prepare',{phaseId:'delivery'});
          await writeFile(path.join(root,'app.js'),'// @clause:CODE-STORY:REQ-001 Returns the reviewed result.\\nexport const answer = 43;');await writeFile(path.join(root,'package.json'),'{}');
        }
        const result=await createNamespaceSourceInspectionEngine({...common,localRecords,localContent}).run('phase.source.inspect',{phaseId:'delivery'});
        assert.equal(result.manifest.status,'inspected');assert.equal(result.manifest.totals.changes,2);
        assert.equal(result.manifest.repositories[0].roles['build-configuration'],1);assert.equal(result.manifest.repositories[0].roles['product-source'],1);
        assert.equal(result.manifest.publicationReadinessInspected,false);assert.equal(result.effects.committed,false);assert.equal(result.effects.testsRun,false);
        const delivery=await createNamespaceDeliveryInspectionEngine({...common,localRecords,localContent}).run('phase.delivery.inspect',{phaseId:'delivery'});
        assert.equal(delivery.manifest.status,'observed');assert.equal(delivery.manifest.evidence.baseline.operationId,'retain-baseline-bytes');
        assert.equal(delivery.manifest.evidence.changes===null,fresh);assert.equal(delivery.manifest.repositories[0].sourceMatched,fresh?null:true);
        assert.equal(delivery.manifest.publicationReadinessInspected,false);assert.equal(delivery.manifest.applicationAcceptanceEstablished,false);
        assert.equal(delivery.manifest.schemaVersion,3);assert.equal(delivery.manifest.analysis===null,fresh);assert.equal(delivery.manifest.clauses.status,'off');
        if(!fresh)assert.deepEqual(delivery.manifest.analysis.files.find(file=>file.path==='app.js').tags.map(tag=>tag.clauseId),['CODE-STORY:REQ-001']);
        const sourceReaders=fresh?[await createFilesystemSourceContentReader({root,id:'installed-source-reader',source:unit.descriptor,maximumChunkBytes:4})]:[];
        if(!fresh)await rm(root,{recursive:true});
        const baseline=await createNamespaceSourceBaselineEngine({...common,sources:[],sourceReaders:[]}).run('source.baseline.retain',{
          operationId:'retain-baseline-bytes',workId,sourceBindingId:'bind-code-source'});
        assert.deepEqual(baseline.record,JSON.parse(await readFile('retained-baseline-record.json','utf8')));assert.equal(baseline.replayed,true);
        const retained=await createNamespaceSourceRetentionEngine({...common,sources:fresh?[unit]:[],sourceReaders,
          localRecords:fresh?localRecords:undefined,localContent:fresh?localContent:undefined})
          .run('phase.source.retain',{operationId:'retain-delivery-bytes',workId,phaseId:'delivery'});
        assert.equal(retained.effects.phasePublished,false);assert.equal(retained.totals.files,2);assert.equal(retained.totals.added,1);
        if(fresh){await writeFile('retained-code-record.json',JSON.stringify(retained.record));
          const analyzed=await createNamespaceDeliveryInspectionEngine({...common,localRecords,localContent}).run('phase.delivery.inspect',{phaseId:'delivery'});
          assert.deepEqual(analyzed.manifest.analysis.retentionRecord,retained.record.content);assert.equal(analyzed.manifest.analysis.totals.tags,1);
          assert.equal(analyzed.manifest.analysis.totals.declarations,0);assert.equal(analyzed.effects.testsRun,false);}
        else{assert.equal(retained.replayed,true);assert.deepEqual(retained.record,JSON.parse(await readFile('retained-code-record.json','utf8')));}
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();privateDatabase.close();}
    `;
    const first=JSON.parse(await run('source-inspection.mjs',source,['fresh']));
    const reopened=JSON.parse(await run('source-inspection.mjs',source,['reopen']));assert.deepEqual(reopened,first);
  });

  await t.test('installed publication retains actual authored bytes and reopens its original receipt in another empty-PATH process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespacePublicationEngine,NAMESPACE_PUBLICATION_PROFILE} from '${packageName}/hosts/namespace-publication';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},privateBinding={kind:'machine-local',deviceId:'portable-device'};
      const scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='portable-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const localRecords=await createFilesystemNamespaceStore({root:path.resolve('private-records'),binding:privateBinding});
      const {DatabaseSync}=await import('node:sqlite');
      const sharedDatabase=new DatabaseSync(path.resolve('configuration-content.db')),privateDatabase=new DatabaseSync(path.resolve('private-content.db'));
      const content=createSqliteContentStore({database:sharedDatabase,binding});
      const localContent=createSqliteContentStore({database:privateDatabase,binding:privateBinding});
      try {
        let calls=0;const access={current(){calls++;if(!fresh)throw Error('An accepted receipt cannot authorize another effect.');
          return {projectId:scope.projectId,principalId:'human-reviewer',actorKind:'human',agentId:'analyst',permissions:['phase.publish'],
            identity:{name:'Example reviewer',email:'reviewer@example.test'}};}};
        const clock={now(){if(!fresh)throw Error('An accepted publication cannot be restamped.');return '2026-11-08T14:00:00.000Z';}};
        const engine=createNamespacePublicationEngine({records,content,localRecords,localContent,scope,workId,authority,access,clock});
        assert.equal(NAMESPACE_PUBLICATION_PROFILE,'sflow-primary-document-publication/v1');
        const result=await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
        assert.equal(result.status,fresh?'published':'retained');assert.equal(result.generation,1);
        assert.deepEqual(result.effects,{committed:fresh,pushed:false});
        const review=await engine.run('phase.review',{phaseId:'intake'}),item=review.manifest.items.find(item=>item.primary);
        assert.equal(review.manifest.generation,1);assert.equal(item.integrity,'matched');
        const document=await engine.run('document.read',{reference:item.reference});
        assert.equal(document.document.content.text,'# Authored intake\\n\\nAn observable requirement.\\n');
        if(!fresh)assert.equal(calls,0);
        process.stdout.write(JSON.stringify(result));
      }finally{sharedDatabase.close();privateDatabase.close();}
    `;
    const first=JSON.parse(await run('publication.mjs',source,['fresh']));
    const replay=JSON.parse(await run('publication.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,status:'retained',effects:{committed:false,pushed:false},retentionReason:'unchanged-document'});
  });

  await t.test('installed specification and plan publication retain their original approvals and reopen without a checkout',async()=>{
    const source=(await readFile(new URL('./helpers/installed-namespace-specification.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName);
    const first=JSON.parse(await run('specification-publication.mjs',source,['fresh']));
    const reopened=JSON.parse(await run('specification-publication.mjs',source,['reopen']));assert.deepEqual(reopened,first);
  });
  await t.test('installed Code evidence reaches a separately authored verifier and replays without the original checkout',async()=>{
    const source=(await readFile(new URL('./helpers/installed-namespace-code-inputs.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName);
    const first=JSON.parse(await run('code-inputs-publication.mjs',source,['fresh']));
    const replayed=JSON.parse(await run('code-inputs-publication.mjs',source,['replay']));assert.deepEqual(replayed,first);
  });
  await t.test('installed submission uses only shared publication records and reopens its exact review packet',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceSubmissionEngine,NAMESPACE_SUBMISSION_PROFILE} from '${packageName}/hosts/namespace-submission';
      import {createNamespaceReadEngine} from '${packageName}/hosts/namespace-reader';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='portable-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding});
      try {
        let calls=0;const access={current(){calls++;if(!fresh)throw Error('An accepted submission cannot authorize another operation.');
          return {projectId:scope.projectId,principalId:'human-reviewer',actorKind:'human',agentId:'analyst',permissions:['phase.submit'],
            identity:{name:'Example reviewer',email:'reviewer@example.test'}};}};
        const clock={now(){if(!fresh)throw Error('The submitted packet cannot be restamped.');return '2026-11-08T15:00:00.000Z';}};
        const engine=createNamespaceSubmissionEngine({records,content,scope,workId,authority,access,clock});
        assert.equal(NAMESPACE_SUBMISSION_PROFILE,'sflow-primary-document-submission/v1');
        const result=await engine.run('phase.submit',{phaseId:'intake'});
        assert.equal(result.status,fresh?'awaiting-approval':'retained');assert.equal(result.generation,1);
        assert.deepEqual(result.effects,{committed:fresh,pushed:false});assert.equal(result.submission.phaseStatus,'awaiting_approval');
        const review=await engine.run('phase.review',{phaseId:'intake'});
        assert.equal(review.manifest.reviewBinding.packetSha256,result.submission.reviewPacket);
        assert.deepEqual(await createNamespaceReadEngine({records,content,scope,workId}).run('phase.review',{phaseId:'intake'}),review);
        const document=await engine.run('document.read',{reference:{kind:'story-document',id:'REVIEW-intake-GEN-1',workId}}),packet=JSON.parse(document.document.content.text);
        assert.equal(document.document.expected.sha256,result.submission.reviewPacket);assert.equal(packet.actor.principalId,'human-reviewer');
        assert.equal(packet.publication.record.namespace,'evidence');assert.equal(Object.hasOwn(packet,'sourceCommit'),false);
        if(!fresh)assert.equal(calls,0);process.stdout.write(JSON.stringify(result));
      }finally{database.close();}
    `;
    const first=JSON.parse(await run('submission.mjs',source,['fresh']));
    const replay=JSON.parse(await run('submission.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,status:'retained',effects:{committed:false,pushed:false}});
  });

  await t.test('installed human approval completes the real namespace Story and acknowledges its receipt in another process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';import {registerHooks} from 'node:module';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      const hooks=registerHooks({resolve(specifier,context,next){if(specifier==='node:child_process'||/\\/(?:git|cli|state)\\.mjs$/.test(specifier))
        throw Error('Unexpected native execution owner: '+specifier);return next(specifier,context);}});
      const {createNamespaceApprovalEngine,NAMESPACE_APPROVAL_PROFILE}=await import('${packageName}/hosts/namespace-approval');
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='portable-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding});
      try {
        const access={current:()=>({projectId:scope.projectId,principalId:'human-reviewer',actorKind:'human',agentId:fresh?null:'another-prompt-agent',
          permissions:fresh?['phase.approve']:[],identity:{name:'Example reviewer',email:'reviewer@example.test'}})};
        const clock={now(){if(!fresh)throw Error('Acknowledgement cannot restamp human approval.');return '2026-11-08T16:00:00.000Z';}};
        const engine=createNamespaceApprovalEngine({records,content,scope,workId,authority,access,clock});
        assert.equal(NAMESPACE_APPROVAL_PROFILE,'sflow-primary-document-approval/v1');
        let confirmation;
        if(fresh){const {manifest}=await engine.run('phase.review',{phaseId:'intake'});confirmation={workId,phase:'intake',generation:manifest.generation,
          reviewPacketSha256:manifest.reviewBinding.packetSha256};}
        const result=await engine.run('phase.approve',{phaseId:'intake',...(confirmation?{confirmation}:{})});
        assert.equal(result.status,'recorded');assert.equal(result.approval.thresholdReached,true);assert.equal(result.currentPhase,null);
        const review=await engine.run('phase.review',{phaseId:'intake'});assert.equal(review.manifest.integrity,'matched');assert.equal(review.manifest.reviewBinding,null);
        const document=await engine.run('document.read',{reference:review.manifest.items.find(item=>item.primary).reference});
        assert.equal(document.document.content.text,'# Authored intake\\n\\nAn observable requirement.\\n');
        await assert.rejects(engine.run('phase.review'),{code:'ENGINE_PHASE_SELECTION_REQUIRED'});
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();hooks.deregister();}
    `;
    const first=JSON.parse(await run('approval.mjs',source,['fresh']));
    const replay=JSON.parse(await run('approval.mjs',source,['replay']));assert.deepEqual(replay,first);
  });

  await t.test('installed v2 submission retains normalized routing inputs and acknowledges them without private drafts',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceStoryEngine} from '${packageName}/hosts/namespace-story';
      import {createNamespacePreparationEngine} from '${packageName}/hosts/namespace-preparation';
      import {createNamespacePublicationEngine} from '${packageName}/hosts/namespace-publication';
      import {createNamespaceSubmissionEngine,NAMESPACE_SUBMISSION_DECISION_PROFILE} from '${packageName}/hosts/namespace-submission';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='routing-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const {DatabaseSync}=await import('node:sqlite'),database=new DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding});let privateDatabase=null;
      try {
        const access={current(){if(!fresh)throw Error('Acknowledgement cannot authorize another routing submission.');
          return {projectId:scope.projectId,principalId:'human-reviewer',actorKind:'human',agentId:'analyst',
            permissions:['story.create','phase.prepare','phase.draft.read','phase.draft.write','phase.publish','phase.submit'],
            identity:{name:'Example reviewer',email:'reviewer@example.test'}};}};
        const clock={now(){if(!fresh)throw Error('Acknowledgement cannot restamp submitted routing inputs.');return '2026-11-08T17:00:00.000Z';}};
        const options={records,content,scope,workId,authority,access,clock};
        if(fresh) {
          const source=(await content.put(scope,'state',Buffer.from('# Routing request\\n\\nRetain the selected channel.\\n'))).reference;
          await createNamespaceStoryEngine(options).run('story.create',{operationId:'create-routing-story',workId,title:'Routed review',
            workTypeId:'routing',configurationId:'approve-configuration',source});
          const privateBinding={kind:'machine-local',deviceId:'portable-device'};
          const localRecords=await createFilesystemNamespaceStore({root:path.resolve('routing-private-records'),binding:privateBinding,create:true});
          privateDatabase=new DatabaseSync(path.resolve('routing-private-content.db'));
          const localContent=createSqliteContentStore({database:privateDatabase,binding:privateBinding,create:true});
          const preparation=createNamespacePreparationEngine({...options,localRecords,localContent});
          await preparation.run('phase.prepare',{phaseId:'intake'});const {manifest}=await preparation.run('phase.draft.read',{phaseId:'intake'});
          const authored=(await localContent.put(scope,'local',Buffer.from('# Retained review\\n\\nThe selected channel is Web.\\n'))).reference;
          await preparation.run('phase.draft.write',{operationId:'author-routing-review',workId,phaseId:'intake',expectedRevision:manifest.draft.revision,
            content:authored,reason:'Retain the actual review before submission.'});
          await createNamespacePublicationEngine({...options,localRecords,localContent}).run('phase.publish',
            {phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
        }
        const engine=createNamespaceSubmissionEngine(options);
        assert.equal(NAMESPACE_SUBMISSION_DECISION_PROFILE,'sflow-primary-document-submission/v2');
        const result=await engine.run('phase.submit',{phaseId:'intake',decisionValues:{channel:fresh?' web ':'Mobile'}});
        assert.equal(result.status,fresh?'awaiting-approval':'retained');
        const resources=await engine.run('phase.review.resources',{phaseId:'intake'});
        const packet=JSON.parse((await engine.run('document.read',{reference:resources.manifest.resources[0].reference})).document.content.text);
        assert.equal(packet.schemaVersion,2);assert.equal(packet.profile,NAMESPACE_SUBMISSION_DECISION_PROFILE);
        assert.deepEqual(packet.routing.record.values,{channel:'Web'});assert.deepEqual(packet.routing.reused,[]);
        assert.equal(packet.routing.record.recordedAt,packet.submittedAt);
        const review=await engine.run('phase.review',{phaseId:'intake'});
        assert.equal(review.manifest.reviewBinding.packetSha256,result.submission.reviewPacket);
        assert.deepEqual(resources.manifest.reviewBinding,review.manifest.reviewBinding);
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();privateDatabase?.close();}
    `;
    const first=JSON.parse(await run('routing-submission.mjs',source,['fresh']));
    const replay=JSON.parse(await run('routing-submission.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,status:'retained',effects:{committed:false,pushed:false}});
  });

  await t.test('installed routed approval records an independent human outcome and acknowledges it in another process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceApprovalEngine,NAMESPACE_ROUTED_APPROVAL_PROFILE} from '${packageName}/hosts/namespace-approval';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='routing-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const database=new (await import('node:sqlite')).DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding});
      try {
        const access={current:()=>({projectId:scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
          identity:{name:'Independent reviewer',email:'independent@example.test'},permissions:fresh?['phase.approve']:[]})};
        const clock={now(){if(!fresh)throw Error('Reopen the original routed receipt.');return '2026-11-08T18:00:00.000Z';}};
        const engine=createNamespaceApprovalEngine({records,content,scope,workId,authority,access,clock});
        assert.equal(NAMESPACE_ROUTED_APPROVAL_PROFILE,'sflow-primary-document-approval/v2');
        let confirmation;
        if(fresh) {
          const {manifest}=await engine.run('phase.review.resources',{phaseId:'intake'});
          for(const resource of manifest.resources)assert.equal((await engine.run('document.read',{reference:resource.reference})).document.integrity,'matched');
          confirmation={workId,phase:'intake',generation:manifest.generation,reviewPacketSha256:manifest.reviewBinding.packetSha256};
        }
        const result=await engine.run('phase.approve',{phaseId:'intake',...(confirmation?{confirmation}:{})});
        assert.equal(result.approval.thresholdReached,true);assert.equal(result.approval.selfApproval,false);assert.equal(result.currentPhase,null);
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();}
    `;
    const first=JSON.parse(await run('routing-approval.mjs',source,['fresh']));
    const replay=JSON.parse(await run('routing-approval.mjs',source,['replay']));assert.deepEqual(replay,first);
  });

  await t.test('one installed Engine authors, publishes, approves, chooses and recovers receipts in another shared-only process',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';import {readFile,writeFile} from 'node:fs/promises';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceEngine} from '${packageName}/hosts/namespace-engine';
      import {NAMESPACE_ROUTING_CHOICE_PROFILE} from '${packageName}/hosts/namespace-routing-choice';
      const fresh=process.argv[2]==='fresh',binding={kind:'shared'},scope={projectId:'portable-config'},authority={id:'application-authority',epoch:1},workId='choice-story';
      const records=await createFilesystemNamespaceStore({root:path.resolve('configuration-records'),binding});
      const {DatabaseSync}=await import('node:sqlite'),database=new DatabaseSync(path.resolve('configuration-content.db'));
      const content=createSqliteContentStore({database,binding});let privateDatabase=null;
      try {
        const clock={now(){if(!fresh)throw Error('An original choice cannot obtain another timestamp.');return '2026-11-08T19:00:00.000Z';}};
        let reviewing=!fresh,working=null;
        if(fresh) {
          const localBinding={kind:'machine-local',deviceId:'choice-device'};
          const localRecords=await createFilesystemNamespaceStore({root:path.resolve('choice-private-records'),binding:localBinding,create:true});
          privateDatabase=new DatabaseSync(path.resolve('choice-private-content.db'));
          working={records:localRecords,content:createSqliteContentStore({database:privateDatabase,binding:localBinding,create:true})};
        }
        const access={current:()=>({projectId:scope.projectId,principalId:reviewing?'independent-reviewer':'human-reviewer',actorKind:'human',
          agentId:reviewing?(fresh?null:'another-prompt'):'analyst',identity:reviewing?{name:'Independent reviewer',email:'independent@example.test'}
            :{name:'Example reviewer',email:'reviewer@example.test'},permissions:fresh?['story.create','phase.prepare','phase.draft.read','phase.draft.write',
              'phase.publish','phase.submit','phase.approve','decision.choose']:[]})};
        const engine=createNamespaceEngine({records,content,scope,workId,authority,clock,access,working});
        let input;
        if(fresh) {
          const source=(await content.put(scope,'state',Buffer.from('# Reviewed direction\\n\\nA human must choose its disposition.\\n'))).reference;
          await engine.run('story.create',{operationId:'create-choice-story',workId,title:'Human-directed review',
            workTypeId:'choice',configurationId:'approve-configuration',source});
          await engine.run('phase.prepare',{phaseId:'intake'});const draft=await engine.run('phase.draft.read',{phaseId:'intake'});
          const authored=(await working.content.put(scope,'local',Buffer.from('# Reviewed outcome\\n\\nThe actual document is retained for an independent human.\\n'))).reference;
          await engine.run('phase.draft.write',{operationId:'write-choice-report',workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
            content:authored,reason:'Retain the authored report.'});
          await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
          await engine.run('phase.submit',{phaseId:'intake'});reviewing=true;
          const resources=await engine.run('phase.review.resources',{phaseId:'intake'});
          for(const resource of resources.manifest.resources)assert.equal((await engine.run('document.read',{reference:resource.reference})).document.integrity,'matched');
          await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId,phase:'intake',generation:1,
            reviewPacketSha256:resources.manifest.reviewBinding.packetSha256}});
          const {manifest}=await engine.run('decision.context');assert.equal(manifest.question.generation,1);
          assert.match(manifest.proof.approvalSha256,/^[a-f0-9]{64}$/u);
          input={workId,expected:manifest.question.key,option:'deliver',reason:'The human reviewed and chose the retained direction.'};
          await writeFile('choice-inputs.json',JSON.stringify(input));
        }else input=JSON.parse(await readFile('choice-inputs.json','utf8'));
        assert.equal(NAMESPACE_ROUTING_CHOICE_PROFILE,'sflow-human-routing-choice/v1');
        const result=await engine.run('decision.choose',input);assert.equal(result.currentPhase,null);assert.equal(result.recordKind,'routing');
        assert.equal(result.record.outcome.by,'person');assert.equal(result.actorId,'independent-reviewer');
        assert.equal((await engine.run('decision.context')).manifest.question,null);
        assert.equal((await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
        process.stdout.write(JSON.stringify(result));
      }finally{database.close();privateDatabase?.close();}
    `;
    const first=JSON.parse(await run('choice.mjs',source,['fresh']));
    const replay=JSON.parse(await run('choice.mjs',source,['replay']));assert.deepEqual(replay,first);
  });

  await t.test('installed execution units run without Git, configuration, providers or an application checkout',async()=>{
    await run('execution.mjs',`
      import assert from 'node:assert/strict';
      import {registerHooks} from 'node:module';
      import {createHash} from 'node:crypto';
      import {readFile} from 'node:fs/promises';
      const hooks=registerHooks({resolve(specifier,context,next){
        if(['model-runner','git-access','git-host-selection','sgos/gvm-adapters','sgos/execution-units','config.mjs'].some(part=>specifier.includes(part))
          ||specifier.endsWith('.ts'))throw Error('Unexpected installed integration: '+specifier);
        return next(specifier,context);
      }});
      const {captureExecutionUnit}=await import('${packageName}/execution');
      const {createExecutionUnitManifest,createAgentTaskContract,createGenericProcessExecutionUnit}=await import('${packageName}/execution/node');
      const digest=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
      const manifest=createExecutionUnitManifest({id:'consumer-process',version:'1.0.0',publisher:'fixture',provider:'local',models:[],
        capabilities:{shell:false},sandbox:{kind:'process',enforcement:'external-attested',attestationSha256:digest('fixture-sandbox')},
        network:{mode:'deny'},toolPolicy:{mode:'none'},risk:{class:'low'},tests:{conformanceReceiptSha256:digest('conformance')},
        command:{executable:process.execPath,executableSha256:'sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
          arguments:['-e',"let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({task:JSON.parse(s).taskId})))"],environmentAllowlist:[]}});
      const unit=captureExecutionUnit(createGenericProcessExecutionUnit(manifest,{root:process.cwd(),authorizeManifest:value=>value.manifestSha256}));
      const contract=createAgentTaskContract({taskId:'sdk-task',processId:'sdk-process',instructionId:'sdk-instruction',objective:'Execute only the fixed fixture.',
        acceptanceClauses:[],policySnapshotSha256:digest('policy'),programSha256:digest('program'),inputs:[],readScope:[],writeScope:[],forbiddenScope:[],
        allowedDevices:[],environmentManifestSha256:digest('environment'),candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],
        budgets:{activeMinutes:1,modelInvocations:0,touchedResources:0},stopConditions:[],executionUnitManifestSha256:manifest.manifestSha256});
      const handle=await unit.start(contract),events=[];for await(const event of unit.observe(handle))events.push(event);
      assert.deepEqual(events.map(event=>event.type),['started','completed']);
      assert.equal((await unit.quiesce(handle)).quiescent,true);const result=await unit.collect(handle);
      assert.deepEqual(result.output,{task:'sdk-task'});assert.equal(result.candidate,null);assert.equal(Object.hasOwn(result,'verification'),false);
      hooks.deregister();
    `);
  });

  await t.test('installed operational history survives another empty-PATH host without Git or lifecycle storage',async()=>{
    const source=`
      import assert from 'node:assert/strict';
      import {registerHooks} from 'node:module';
      import {mkdir,writeFile,readFile} from 'node:fs/promises';
      import path from 'node:path';
      import {DatabaseSync} from 'node:sqlite';
      const hooks=registerHooks({resolve(specifier,context,next){
        if(['model-runner','git-access','sgos/store.mjs','sgos/runtime.mjs','config.mjs'].some(part=>specifier.includes(part)))throw Error('Unexpected installed owner: '+specifier);
        return next(specifier,context);
      }});
      const {createFilesystemNamespaceStore}=await import('${packageName}/storage/filesystem');
      const {createSqliteContentStore}=await import('${packageName}/storage/sqlite-content');
      const {createNamespaceSgosOperationalStore}=await import('${packageName}/execution/storage/namespace');
      const {createDurableExecutionUnit,createNodeExecutionOwner}=await import('${packageName}/execution/runtime');
      const {createDeterministicTranslatorExecutionUnit,createAgentTaskContract}=await import('${packageName}/execution/node');
      const fresh=process.argv[2]==='fresh',root=path.join(process.cwd(),'operational-history'),binding={kind:'shared'},scope={projectId:'execution-project'};
      if(fresh)await mkdir(root);
      const records=await createFilesystemNamespaceStore({root:path.join(root,'metadata'),binding,create:fresh});
      const database=new DatabaseSync(path.join(root,'content.db'));
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      try{
        const content=createSqliteContentStore({database,binding,create:fresh});
        const store=createNamespaceSgosOperationalStore({records,content,scope,storeId:'fixture-execution'});
        const executionStore=createNamespaceSgosOperationalStore({records,content,scope,storeId:'installed-owned-execution'});
        const executor=createDeterministicTranslatorExecutionUnit(),hash='sha256:'+'a'.repeat(64);
        const contract=createAgentTaskContract({taskId:'archive-task',processId:'ARCHIVE',instructionId:'execute',objective:'Retain a real port result.',
          acceptanceClauses:[],policySnapshotSha256:hash,programSha256:hash,inputs:[],readScope:[],writeScope:[],forbiddenScope:[],allowedDevices:[],
          environmentManifestSha256:hash,candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],
          budgets:{activeMinutes:1,modelInvocations:0,touchedResources:0},stopConditions:[],executionUnitManifestSha256:executor.descriptor().manifestSha256});
        const execution=createDurableExecutionUnit({unit:fresh?executor:{...executor,start(){throw Error('An acknowledged execution must not run again.');}},
          store:executionStore,content,scope,owner:createNodeExecutionOwner({hostId:fresh?'original-host':'next-host'}),clock:{now:()=>new Date().toISOString()}});
        if(fresh){const handle=await execution.start(contract),candidate=await execution.collect(handle);
          await writeFile(path.join(root,'execution.json'),JSON.stringify({handle,candidate,quiet:await execution.quiesce(handle)}));
        }else{const expected=JSON.parse(await readFile(path.join(root,'execution.json'),'utf8'));
          assert.deepEqual(await execution.start(contract),expected.handle);assert.deepEqual(await execution.collect(expected.handle),expected.candidate);
          assert.deepEqual(await execution.quiesce(expected.handle),expected.quiet);}
        if(fresh){const initial=await store.read();await store.transact({expectedRevision:initial.revision,expectedStateSha256:initial.stateSha256,
          changes:[{op:'put',key:'attempt/one',value:{state:'running',owner:'first-device'}}]});
          const running=await store.read();const completed=await store.transact({expectedRevision:running.revision,expectedStateSha256:running.stateSha256,
            changes:[{op:'put',key:'attempt/one',value:{state:'succeeded',result:{passed:2,failed:0}}}]});
          await writeFile(path.join(root,'expected.json'),JSON.stringify(completed));
        }else{const expected=JSON.parse(await readFile(path.join(root,'expected.json'),'utf8'));assert.deepEqual(await store.read(),expected);
          assert.equal((await store.verify()).eventCount,2);const plan=await store.planRollback(1);
          await store.rollback({revision:1,confirmationSha256:plan.confirmationSha256});
          assert.equal((await store.read()).revision,3);assert.equal((await store.read()).entries['attempt/one'].state,'running');
          const key='sgos/operational/fixture-execution/head',head=(await records.read(scope,'runtime',key)).record;
          const original=await content.read(scope,head.value.lineage);
          const bytes=Buffer.concat([Buffer.from([239,187,191]),Buffer.from(original.data)]),lineage=(await content.put(scope,'runtime',bytes)).reference;
          await records.transact(scope,{operationId:'installed-bom-fixture',preconditions:[{namespace:'runtime',key,version:head.version}],
            changes:[{op:'put',namespace:'runtime',key,immutable:false,value:{...head.value,lineage}}],events:[]});
          await assert.rejects(store.read(),{code:'SGOS_OPERATIONAL_STORE_CORRUPT'});}
        for(const namespace of ['state','config','evidence'])assert.deepEqual((await records.list(scope,namespace,{limit:100})).entries,[]);
      }finally{database.close();hooks.deregister();}
    `;
    await run('operational-history.mjs',source,['fresh']);await run('operational-history.mjs',source,['reopen']);
  });

  await t.test('installed report parsing replays genuine Node output without a repository or execution imports',async()=>{
    await run('report-reader.mjs',`
      import assert from 'node:assert/strict';
      import {writeFile} from 'node:fs/promises';
      import {spawnSync} from 'node:child_process';
      import {registerHooks} from 'node:module';
      await writeFile('arithmetic.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';test('adds',()=>assert.equal(1+1,2));");
      const hooks=registerHooks({resolve(specifier,context,next){
        if(['node:fs','node:fs/promises','node:child_process'].includes(specifier)||['git-access','config.mjs','model-runner'].some(value=>specifier.includes(value)))throw Error('Unexpected report dependency: '+specifier);
        return next(specifier,context);
      }});
      const {createNodeTestReportCodec}=await import('${packageName}/testing/node');
      const codec=createNodeTestReportCodec(),env={...process.env};delete env.NODE_TEST_CONTEXT;
      const observed=spawnSync(process.execPath,['--test','--test-reporter=tap','arithmetic.test.mjs'],{encoding:'utf8',env,timeout:10000});
      assert.equal(observed.status,0,observed.stderr);
      const replay=codec.replayTestReports('node-tap',[{contents:observed.stdout}]);
      assert.deepEqual(replay.tests,{discovered:1,passed:1,failed:0,skipped:0});
      assert.equal(replay.testcaseObservation,null,'ordinary TAP counts cannot invent exact source identities');
      await codec.prepareTestReportReader('playwright-json');
      assert.equal(codec.replayTestReports('playwright-json',[{contents:'{"suites":[],"stats":{"expected":0,"unexpected":0,"flaky":0,"skipped":0}}'}]).tests.discovered,0);
      assert.equal(Object.hasOwn(replay,'approved'),false);hooks.deregister();
    `);
  });

  await t.test('installed local checks execute pinned tests and retain actual bytes without Git or a CLI',async()=>{
    await run('actual-check.mjs',`
      import assert from 'node:assert/strict';import {mkdir,writeFile,readFile} from 'node:fs/promises';
      import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import path from 'node:path';
      import {createNodeCheckExecutionUnit} from '${packageName}/testing/execution';
      import {createAgentTaskContract} from '${packageName}/execution/node';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      const database=new DatabaseSync('actual-check-content.db');database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      const content=createSqliteContentStore({database,binding:{kind:'shared'},create:true});
      const root=path.resolve('actual-check-source');await mkdir(root);
      await writeFile(path.join(root,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('real installed check',()=>assert.equal(3+3,6));");
      const digest='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
      const unit=await createNodeCheckExecutionUnit({id:'installed-check',projectId:'installed',repositoryId:'application',root,content,
        command:{executable:process.execPath,executableSha256:digest,arguments:['--test','--test-reporter=tap','case.test.mjs'],environment:{}},
        report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256});
      const contract=createAgentTaskContract({taskId:'check-one',processId:'PROC-installed',instructionId:'test',objective:'Run the installed check.',
        acceptanceClauses:[],policySnapshotSha256:digest,programSha256:digest,inputs:[],readScope:['repository:application'],writeScope:['repository:application'],
        forbiddenScope:[],allowedDevices:[],environmentManifestSha256:digest,candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],
        budgets:{activeMinutes:1,modelInvocations:0,touchedResources:10},stopConditions:[],executionUnitManifestSha256:unit.descriptor().manifestSha256});
      const handle=await unit.start(contract),result=(await unit.collect(handle)).output;
      assert.equal(result.process.status,0);assert.equal(result.source.unchanged,true);assert.equal(result.reports.parsed.tests.passed,1);
      assert.equal(result.reports.parsed.testcaseObservation,null);assert.equal(Object.hasOwn(result,'verification'),false);
      const retained=await content.read({projectId:'installed'},result.stdout);assert.equal(retained.status,'present');
      assert.match(Buffer.from(retained.data).toString(),/real installed check/);database.close();
    `);
  });

  await t.test('installed registered checks publish, submit and receive independent human approval with shared-only takeover',async()=>{
    const source=`
      import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile,readFile} from 'node:fs/promises';
      import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceEngine} from '${packageName}/hosts/namespace-engine';
      import {createNamespacePhaseChecksEngine} from '${packageName}/hosts/namespace-checks';
      import {createFilesystemSourceUnit} from '${packageName}/sources/filesystem';
      import {createNodeCheckExecutionUnit} from '${packageName}/testing/execution';
      import {createNodeExecutionOwner} from '${packageName}/execution/runtime';
      const fresh=process.argv[2]==='fresh',scope={projectId:'package-checks'},workId='checked-story',authority={id:'application-authority',epoch:1};
      const shared={kind:'shared'},records=await createFilesystemNamespaceStore({root:path.resolve('registered-check-records'),binding:shared,create:fresh});
      const database=new DatabaseSync('registered-check-content.db');database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      const content=createSqliteContentStore({database,binding:shared,create:fresh});let localDatabase;
      const clock={now(){if(!fresh)throw Error('An acknowledgement cannot restamp the check.');return '2026-11-09T00:00:00.000Z';}};
      const identity={name:'Example reviewer',email:'reviewer@example.test',login:null};
      let principalId='check-author',person=identity,agentId=fresh?'analyst':null;
      const access={current(){return {projectId:scope.projectId,principalId,actorKind:'human',identity:person,agentId,
        permissions:fresh?['project.enroll','configuration.approve','story.create','source.bind','clarification.record','phase.enter','phase.context.read','phase.prepare','phase.draft.read','phase.draft.write','phase.checks.run','phase.publish','phase.submit','phase.approve']:[]};}};
      const common={records,content,scope,workId,authority,access,clock},input={operationId:'run-pinned-checks',workId,phaseId:'intake'};
      try{
        let engine;
        if(fresh){
          const localBinding={kind:'machine-local',deviceId:'installed-check-device'};
          const localRecords=await createFilesystemNamespaceStore({root:path.resolve('registered-check-local-records'),binding:localBinding,create:true});
          localDatabase=new DatabaseSync('registered-check-local-content.db');localDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
          const localContent=createSqliteContentStore({database:localDatabase,binding:localBinding,create:true});
          const root=path.resolve('registered-check-source');await mkdir(root);
          await writeFile(path.join(root,'case.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('real registered check',()=>assert.equal(7+1,8));");
          const source=await createFilesystemSourceUnit({root,id:'app-checkout',projectId:scope.projectId,repositoryId:'app'});
          const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
          const unit=await createNodeCheckExecutionUnit({id:'registered-node-check',root,projectId:scope.projectId,repositoryId:'app',content,
            command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=tap','case.test.mjs'],environment:{}},
            report:{adapter:'node-tap',files:[]},authorizeCommand:value=>value.manifestSha256});
          engine=createNamespaceEngine({...common,working:{records:localRecords,content:localContent},sources:[source],checks:{
            owner:createNodeExecutionOwner({hostId:'registered-check-host'}),bindings:[{phaseId:'intake',commandId:'node-tests',repositoryId:'app',executable:'node',executableSha256,environment:{},unit}]}});
          await engine.run('project.enroll',{operationId:'enroll-check-project'});
          const text=async value=>(await content.put(scope,'config',Buffer.from(value))).reference,body=await text('# Review template');
          const packet={schemaVersion:1,format:'sflow-namespace-configuration-source/v1',definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',
            phases:{intake:{label:'Intake',clarification:{mode:'required',maxQuestions:2,markers:{mode:'off'}},artifact:{path:'artifacts/intake/plan.md'},defaultTemplate:'intake.md',
              approval:{authorities:['reviewers'],minimum:1,rejectTo:['intake'],allowSelfApproval:false},qualityCommands:[{id:'node-tests',kind:'test',modelPolicy:'never',
                argv:['node','--test','--test-reporter=tap','case.test.mjs'],result:{adapter:'node-tap',path:'results/tests.tap'}}]}},
            approvalAuthorities:{reviewers:{members:[{email:'reviewer@example.test'},{email:'independent@example.test'}]}},workTypes:{simple:{label:'Reviewed checks',phases:['intake'],
              omits:['scope','plan','implement','verify'].map(responsibility=>({responsibility,reason:'This workflow reviews a document and existing tests without delivering new application behavior.',authority:'reviewers'}))}}},
            agents:[{id:'analyst',label:'Analyst',phases:['intake'],defaultFor:['intake'],mode:'read-write',body,skills:[],instructions:[]}],
            skills:[],instructions:[],templates:[{path:'singularity/templates/intake.md',body}],files:[]};
          const configuration=await text(JSON.stringify(packet));await engine.run('configuration.approve',{operationId:'approve-check-config',source:configuration,expectedRevision:null,confirm:configuration.sha256,reason:'Reviewed the actual check workflow.'});
          const storySource=(await content.put(scope,'state',Buffer.from('Retain actual existing test execution.'))).reference;
          const story=await engine.run('story.create',{operationId:'create-check-story',workId,title:'Check existing behavior',workTypeId:'simple',configurationId:'approve-check-config',source:storySource});
          await engine.run('source.bind',{operationId:'bind-check-source',workId,expectedRevision:story.revision,repositories:['app'],reason:'Select the real application bytes.'});
          const entry=await engine.run('phase.enter',{phaseId:'intake',compose:true});
          assert.equal(entry.status,'clarification-required');assert.equal(entry.effects.modelInvocations,0);
          assert.equal(entry.manifest.execution.inspected,false);assert.equal(entry.manifest.readsVerified,false);
          const resource=entry.manifest.resources.find(item=>item.kind==='story-source');
          const sourceRead=await engine.run('phase.context.read',{workId,phaseId:'intake',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});
          assert.equal(sourceRead.content.text,'Retain actual existing test execution.');
          const checkpoint=await engine.run('clarification.status',{phaseId:'intake'});assert.equal(checkpoint.ready,false);
          assert.equal(checkpoint.context.sha256,entry.manifest.clarification.contextSha256);
          const replyInput={operationId:'human-check-context',workId,phaseId:'intake',contextSha256:checkpoint.context.sha256,
            responses:[{question:'Which behavior is in scope?',answer:'Review the existing application tests and retain their actual passing execution.'}]};
          const reply=await engine.run('clarification.record',replyInput);
          await writeFile('registered-check-clarification.json',JSON.stringify({input:replyInput,result:reply}));
          await engine.run('phase.prepare',{phaseId:'intake'});const draft=await engine.run('phase.draft.read',{phaseId:'intake'});
          const authored=(await localContent.put(scope,'local',Buffer.from('# Authored review artifact'))).reference;
          await engine.run('phase.draft.write',{operationId:'author-check-draft',workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,content:authored,reason:'Complete the check context.'});
        }else engine=createNamespacePhaseChecksEngine({...common,checks:{}});
        const result=await engine.run('phase.checks.run',input);assert.equal(result.verdict,'passed');assert.equal(result.checks[0].tests.passed,1);
        assert.equal(result.status,fresh?'recorded':'retained');assert.equal(result.effects.committed,fresh);assert.equal(result.effects.approvalRecorded,false);
        if(fresh){
          assert.equal((await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'published');
          const entry=await engine.run('phase.enter',{phaseId:'intake',compose:true});
          assert.equal(entry.status,'retained-generation');assert.equal(entry.manifest.clarification.questioningAllowed,false);
          assert.equal(entry.manifest.clarification.recordingAllowed,false);
          const answers=entry.manifest.resources.find(item=>item.kind==='human-clarifications');
          const answerBody=await engine.run('phase.context.read',{workId,phaseId:'intake',contextSha256:entry.manifest.context.sha256,resourceId:answers.id});
          assert.equal(JSON.parse(answerBody.content.text).responses[0].question,'Which behavior is in scope?');
          assert.equal((await engine.run('phase.submit',{phaseId:'intake'})).status,'awaiting-approval');
          const review=await engine.run('phase.review',{phaseId:'intake'}),binding=review.manifest.reviewBinding;
          principalId='independent-human';person={name:'Independent reviewer',email:'independent@example.test',login:null};agentId=null;
          const approved=await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId,phase:'intake',generation:1,reviewPacketSha256:binding.packetSha256}});
          assert.equal(approved.approval.thresholdReached,true);assert.equal(approved.approval.selfApproval,false);assert.equal(approved.currentPhase,null);
        }else{
          const takeover=createNamespaceEngine(common);
          const original=JSON.parse(await readFile('registered-check-clarification.json','utf8'));
          const reply=await takeover.run('clarification.record',original.input);assert.equal(reply.replayed,true);
          assert.deepEqual(reply.reference,original.result.reference);assert.equal(reply.recordedAt,original.result.recordedAt);
          const checkpoint=await takeover.run('clarification.status',{phaseId:'intake'});
          assert.equal(checkpoint.status,'published');assert.equal(checkpoint.checkpoint.questioningAllowed,false);

          assert.equal((await takeover.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
          assert.equal((await takeover.run('phase.review',{phaseId:'intake'})).manifest.integrity,'matched');
        }
        process.stdout.write(JSON.stringify(result));
      }finally{localDatabase?.close();database.close();}
    `;
    const first=JSON.parse(await run('registered-checks.mjs',source,['fresh']));
    const later=JSON.parse(await run('registered-checks.mjs',source,['replay']));
    assert.deepEqual(later.record,first.record);assert.equal(later.recordedAt,first.recordedAt);
  });

  await t.test('the installed opt-in Git reader captures real local changes with an explicit binary and no CLI discovery',async()=>{
    let executable;
    for(const directory of (process.env.PATH??'').split(path.delimiter))try{executable=await realpath(path.join(directory,process.platform==='win32'?'git.exe':'git'));break;}catch{}
    assert.ok(executable,'A real Git binary is required for the installed reader qualification');
    await run('git-source.mjs',`
      import assert from 'node:assert/strict';
      import {execFileSync} from 'node:child_process';
      import {mkdir,readFile,writeFile} from 'node:fs/promises';
      import {createHash} from 'node:crypto';
      import path from 'node:path';
      import {createFilesystemSourceUnit} from '${packageName}/sources/filesystem';
      import {createNodeGitSourceControlReader} from '${packageName}/sources/git';
      const executable=process.argv[2],root=process.argv[3];await mkdir(root);
      const git=(...args)=>execFileSync(executable,args,{cwd:root,encoding:'utf8',env:process.env}).trim();
      git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');
      await writeFile(path.join(root,'app.js'),'baseline bytes');git('add','app.js');git('commit','-qm','baseline');
      const baselineCommit=git('rev-parse','HEAD');await writeFile(path.join(root,'app.js'),'current bytes');
      await writeFile(path.join(root,'new.js'),'new bytes');
      const source=await createFilesystemSourceUnit({root,id:'app-source',projectId:'project',repositoryId:'app'});
      const reader=await createNodeGitSourceControlReader({id:'actual-git',root,source:source.descriptor,baselineCommit,
        git:{executable,executableSha256:'sha256:'+createHash('sha256').update(await readFile(executable)).digest('hex')},authorizeCapture:()=>true});
      const subject={workId:'application',phase:'implementation',generation:1,generationIntentId:'generation-one'};
      const first=await reader.capture(subject),second=await reader.capture(subject);
      assert.equal(first.observation.control.entries.length,2);assert.equal(second.revision,first.revision);
      assert.equal(second.metrics.baselineCacheReused,true);assert.ok(first.metrics.gitCalls>second.metrics.gitCalls);
      assert.equal(first.observation.baseline.entries[0].sha256,createHash('sha256').update('baseline bytes').digest('hex'));
      assert.equal(first.observation.current.snapshot.entries[0].sha256,createHash('sha256').update('current bytes').digest('hex'));
      assert.equal(JSON.stringify(first).includes(root),false);assert.equal(Object.hasOwn(first,'publicationReady'),false);
    `,[executable,path.join(directory,'git-source')]);
  });
  await t.test('installed control evidence reopens an actual accepted generation without a checkout or Git executable',async sub=>{
    const {namespaceSourceControlFixture}=await import('./helpers/namespace-source-control-fixture.mjs');
    const f=await namespaceSourceControlFixture(sub),original=await f.engine.run('phase.source-control.retain',f.input),before=await f.head();
    const facts={...await f.access.current({projectId:f.scope.projectId,workId:f.inputs.workId,operation:'phase.source.retain'}),permissions:[],agentId:null};
    await rm(f.sourceRoot,{recursive:true});
    const result=JSON.parse(await run('retained-git-control.mjs',`
      import path from 'node:path';
      import {createFilesystemNamespaceStore} from '${packageName}/storage/filesystem';
      import {DatabaseSync} from 'node:sqlite';
      import {createSqliteContentStore} from '${packageName}/storage/sqlite-content';
      import {createNamespaceSourceControlEngine} from '${packageName}/hosts/namespace-source-control';
      const selected=JSON.parse(process.argv[2]),database=new DatabaseSync(path.join(selected.directory,'content.db'));
      database.enableDefensive(true);database.enableLoadExtension(false);
      const records=await createFilesystemNamespaceStore({root:path.join(selected.directory,'records'),binding:{kind:'shared'},create:false});
      try{const content=createSqliteContentStore({database,binding:{kind:'shared'},create:false});
        const engine=createNamespaceSourceControlEngine({records,content,scope:selected.scope,workId:selected.input.workId,authority:selected.authority,
          access:{current:()=>selected.facts},clock:{now(){throw Error('Accepted control evidence cannot be restamped.');}}});
        process.stdout.write(JSON.stringify(await engine.run('phase.source-control.retain',selected.input)));
      }finally{records.close?.();database.close();}
    `,[JSON.stringify({directory:f.directory,scope:f.scope,authority:f.authority,input:f.input,facts})]));
    assert.deepEqual(result.record,original.record);assert.equal(result.recordedAt,original.recordedAt);assert.equal(result.status,'retained');
    assert.deepEqual(await f.head(),before);
  });
  await t.test('installed specification values reproduce native indexes without a checkout or implicit infrastructure',async()=>{
    const oracle=JSON.parse(await readFile(path.join(root,'test/fixtures/specification-values/native-v1.json'),'utf8'));
    const claims=JSON.parse(await readFile(path.join(root,'test/fixtures/specification-claims/native-v2.json'),'utf8'));
    const analysis=JSON.parse(await readFile(path.join(root,'test/fixtures/specification-analysis/native-v1.json'),'utf8'));
    const {STARTER_CHECKLIST}=await import('../src/engine-compatibility/node-specification-policy.mjs');
    const declarations={profile:'sflow-specification-analysis-declarations/v1',requiredSections:['Actors','User scenarios','Requirements'],starterChecklist:STARTER_CHECKLIST};
    await run('specification-values.mjs',`
      import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import path from 'node:path';import {registerHooks} from 'node:module';
      const blocked=[],hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:')){blocked.push(specifier);throw Error('Unexpected infrastructure import: '+specifier);}return next(specifier,context);}});
      const pure=await import('${packageName}/specifications');
      const digest=Object.freeze({profile:pure.TEXT_DIGEST_PROFILE,sha256Utf8:text=>createHash('sha256').update(text).digest('hex')});
      const rules=pure.specificationValuePolicies(digest),captured=JSON.parse(${JSON.stringify(JSON.stringify(oracle))});
      for(const entry of captured.indexes){const bytes=entry.bytes?Buffer.from(entry.bytes):Buffer.from(entry.text);
        const clauses=rules.extractClauses(bytes.toString('utf8'),{sourcePath:'spec.md',namespace:entry.options.policy?.namespace??null});
        const source={path:'spec.md',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
        assert.deepEqual(rules.specificationIndexRecord({...entry.options,source,clauses}),entry.index);}
      const paths=Object.freeze({profile:pure.CONFIGURATION_PATH_SYNTAX_V2,grammar:path.sep==='\\\\'?'win32':'posix',
        isAbsolute:path.isAbsolute,normalize:path.normalize,parse:path.parse,posixIsAbsolute:path.posix.isAbsolute,posixNormalize:path.posix.normalize,
        posixBasename:path.posix.basename,posixDirname:path.posix.dirname,posixRelative:path.posix.relative,win32IsAbsolute:path.win32.isAbsolute,toPosix:value=>value.split(path.sep).join('/')});
      const claimRules=pure.specificationClaimPolicies(paths,Object.freeze({profile:pure.TEXT_VALUE_SYNTAX_PROFILE,byteLengthUtf8:value=>Buffer.byteLength(value),sha256Utf8:digest.sha256Utf8}));
      const allocationContracts=pure.verificationContractPolicies(paths,digest);
      assert.deepEqual(allocationContracts.requiredAcceptanceFromPlan(['STORY:AC-001','STORY:AC-002'],{'STORY:AC-001':{tests:['test/app.js'],steps:['other']},'STORY:AC-002':{tests:['test/here.js']}},new Map(),'code'),['STORY:AC-002']);
      const repositories=pure.repositoryPlanPolicies(paths,['singularity/work-items']),qualified=repositories.deriveRepositoryPlan(
        '## Repository roots\\n\\n| Repository | Plan root |\\n| --- | --- |\\n| app | frontend |\\n| service | backend |',
        {claims:{'STORY:REQ-001':{expectedPaths:['frontend/src/app.js','backend/src/app.js'],tests:[]}},supportingFiles:[]});
      assert.equal(qualified.format,pure.REPOSITORY_PLAN_PROFILE);
      assert.deepEqual(repositories.repositoryPlanProjection(qualified,'service').claims['STORY:REQ-001'].expectedPaths,['src/app.js']);
      assert.throws(()=>repositories.assertRepositoryPlanSources(qualified,'code',['app']),error=>error.code==='SPEC_REPOSITORY_BINDING_REQUIRED');
      const analysisRules=pure.specificationAnalysisPolicies(Object.freeze({profile:pure.TEXT_VALUE_SYNTAX_PROFILE,byteLengthUtf8:value=>Buffer.byteLength(value),sha256Utf8:digest.sha256Utf8}),
        JSON.parse(${JSON.stringify(JSON.stringify(declarations))})),analysisApi={...pure,...analysisRules};
      for(const entry of JSON.parse(${JSON.stringify(JSON.stringify(analysis))}).cases) {
        let actual;try{actual={value:analysisApi[entry.method](...entry.args)};}
        catch(error){actual={error:{name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode}};}
        assert.deepEqual(JSON.parse(JSON.stringify(actual)),entry.outcome,entry.id);
      }
      const claimCapture=JSON.parse(${JSON.stringify(JSON.stringify(claims))});
      const replayClaim=(api,entry)=>{const replay=api[entry.operation+'Replay'](...entry.args);let step=replay.next(),clocks=0;
        while(!step.done){assert.equal(step.value,pure.SPECIFICATION_CLAIM_TIMESTAMP_REQUEST);clocks++;step=replay.next('2026-02-03T04:05:06.789Z');}
        assert.equal(clocks,entry.outcome.clocks);assert.deepEqual(step.value,entry.outcome.result);};
      for(const name of ['ordinary','inspect-complete','projection-exact-bindings'])replayClaim(claimRules,claimCapture.cases.find(entry=>entry.name===name));
      assert.deepEqual(blocked,[]);hooks.deregister();
      const native=await import('${packageName}/specifications/node');
      assert.deepEqual(native.analyzeSpecification('## Actors\\nUser.\\n## User scenarios\\nConvert.\\n## Requirements\\n[VALUE:REQ-001] Exact.',{namespace:'VALUE',policy:{mode:'enforce'}}).findings,[]);
      assert.equal(native.evaluateApprovalChecklist({policy:{mode:'enforce'},decisions:[]}).errors.length,6);
      const entry=captured.cases.find(entry=>entry.name==='contract-default');
      const contracts=native.parseVerificationContracts(...entry.args);assert.deepEqual(contracts,entry.outcome.result);
      assert.equal(native.contractSha256(contracts[0]).length,71);
      replayClaim(native,claimCapture.cases.find(entry=>entry.name==='derive-complete'));
      assert.throws(()=>native.extractClauses('[VALUE:AC-001] Depends on VALUE:REQ-999.'),{code:'SPEC_CLAUSE_DEPENDENCY_MISSING'});
      const findings=[];for(let index=0;index<260;index++)pure.collectDraftDiagnostic(findings,{message:'Actual input required.'},{line:index});
      assert.deepEqual(pure.draftDiagnosticSummary(findings),{maximum:256,omitted:4,complete:false});
      assert.equal(Object.hasOwn(rules,'buildSpecIndex'),false,'value rules must not discover or write files');
    `);
  });
  await t.test('installed source analysis preserves the native oracle with infrastructure denied and an empty PATH',async()=>{
    const captured=JSON.parse(await readFile(path.join(root,'test/fixtures/source-analysis/native-v1.json'),'utf8'));
    await run('source-analysis-values.mjs',`
      import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';
      const unexpected=[],hook=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:')){unexpected.push(specifier);throw Error('Unexpected source-analysis infrastructure: '+specifier);}return next(specifier,context);}});
      const pure=await import('${packageName}/specifications'),oracle=JSON.parse(${JSON.stringify(JSON.stringify(captured))}),
        values=pure.javascriptDeclarationPolicies(Object.freeze({profile:pure.TEXT_DIGEST_PROFILE,sha256Utf8:text=>createHash('sha256').update(text).digest('hex')})),
        expand=source=>typeof source==='string'?source:source.repeat.repeat(source.count);
      const compare=api=>{
        for(const row of oracle.declarations)assert.deepEqual(JSON.parse(JSON.stringify(api.scanJavaScriptDeclarations(expand(row.source),row.options))),row.expected,row.id);
        for(const row of oracle.sources)assert.deepEqual(api.scanSourceClauseTags(row.source,row.options),row.expected,row.id);
      };
      compare({...pure,...values});assert.deepEqual(unexpected,[]);hook.deregister();
      const native=await import('${packageName}/specifications/node');compare(native);
      assert.equal(native.JAVASCRIPT_DECLARATION_SCHEMA,'javascript-test-v2');
      assert.equal(native.tokenizeJavaScript,pure.tokenizeJavaScript);assert.equal(native.javascriptSourceComments,pure.javascriptSourceComments);
      assert.throws(()=>pure.javascriptDeclarationPolicies(Object.freeze({profile:pure.TEXT_DIGEST_PROFILE,sha256Utf8:()=> 'wrong'}))
        .scanJavaScriptDeclarations("test('actual',()=>{});",{sourcePath:'test.js',framework:'jest'}),{code:'ENGINE_TEXT_DIGEST_RESULT_INVALID'});
    `);
  });
  await t.test('installed implementation bindings replay actual native regions without a checkout or implicit I/O',async()=>{
    const captured=JSON.parse(await readFile(path.join(root,'test/fixtures/implementation-bindings/native-v1.json'),'utf8'));
    await run('implementation-binding-values.mjs',`
      import assert from 'node:assert/strict';import path from 'node:path';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';
      const blocked=[],hook=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:')){blocked.push(specifier);throw Error('Unexpected binding infrastructure: '+specifier);}return next(specifier,context);}});
      const pure=await import('${packageName}/specifications'),oracle=JSON.parse(${JSON.stringify(JSON.stringify(captured))}),
        paths=Object.freeze({profile:pure.CONFIGURATION_PATH_SYNTAX_V2,grammar:path.sep==='\\\\'?'win32':'posix',isAbsolute:path.isAbsolute,normalize:path.normalize,parse:path.parse,
          posixIsAbsolute:path.posix.isAbsolute,posixNormalize:path.posix.normalize,posixBasename:path.posix.basename,posixDirname:path.posix.dirname,posixRelative:path.posix.relative,
          win32IsAbsolute:path.win32.isAbsolute,toPosix:value=>value.split(path.sep).join('/')}),
        values=pure.implementationBindingPolicies(paths,Object.freeze({profile:pure.TEXT_DIGEST_PROFILE,sha256Utf8:value=>createHash('sha256').update(value).digest('hex')}));
      const replay=(method,row)=>{const run=method(row.input);let step=run.next();while(!step.done){const request=step.value;
        if(request.kind==='implementation-diff-preview')step=run.next(row.preview);else{assert.equal(request.kind,'implementation-source');assert.ok(Object.hasOwn(row.sources,request.path));step=run.next(row.sources[request.path]);}}
        assert.deepEqual(step.value,row.expected,row.id);};
      for(const row of oracle.cases)replay(values.implementationBindingsReplay,row);
      const docs=pure.codeDocumentationPolicies(paths),polyglot=pure.polyglotPathPolicies(paths);
      for(const row of oracle.values)assert.deepEqual(pure.publicDeclarations(row.source,row.language),row.expected);
      for(const row of oracle.paths){assert.equal(docs.documentationLanguage(row.file),row.language);assert.equal(docs.unsupportedSourceLanguage(row.file),row.unsupported);}
      for(const row of oracle.lexicalCases){assert.equal(pure.maskPolyglotNonCode(row.source,row.language),row.mask);assert.deepEqual(pure.extractPolyglotSymbols(row.source,row.language),row.symbols);assert.deepEqual(pure.extractPolyglotImports(row.source,row.language),row.imports);}
      for(const row of oracle.resolutions)assert.equal(polyglot.resolvePolyglotLocal(...row.args),row.expected);
      for(const row of oracle.decisions){let actual;try{actual={value:pure.reviewBindings(...row.args)};}catch(error){actual={error:{name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode}};}assert.deepEqual(JSON.parse(JSON.stringify(actual)),row.outcome);}
      assert.deepEqual(blocked,[]);hook.deregister();
      const native=await import('${packageName}/specifications/node');for(const row of oracle.cases)replay(native.implementationBindingsReplay,row);
      assert.equal(native.reviewBindings,pure.reviewBindings);assert.equal(native.publicDeclarations,pure.publicDeclarations);
      const run=values.implementationBindingsReplay(oracle.cases[0].input);assert.equal(run.next().done,false);
      const failure=Object.assign(Error('Original evidence storage denied.'),{code:'EACCES'});assert.throws(()=>run.throw(failure),error=>error===failure);
    `);
  });
  await t.test('installed source-tag origin values replay original native line ownership without a checkout or implicit infrastructure',async()=>{
    const oracle=JSON.parse(await readFile(new URL('./fixtures/source-tag-origin/native-v1.json',import.meta.url),'utf8'));
    for(const row of oracle.cases)for(const trace of Object.values(row.traces))for(const saved of trace)if(saved.value!==undefined) {
      if(saved.name==='baseline-texts')saved.value=saved.value.map(([path,bytes])=>[path,Buffer.from(bytes,'base64').toString('utf8')]);
      if(saved.name==='line-patch')saved.value=gitTagLineDeltas(saved.value);
    }
    const source=(await readFile(new URL('./helpers/installed-source-tag-origin.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName)
      .replace("'__ORIGIN_ORACLE__'",JSON.stringify(JSON.stringify(oracle)));
    await run('source-tag-origin-values.mjs',source);
  });
  await t.test('installed coverage values preserve native outcomes with infrastructure denied and an empty PATH',async()=>{
    const oracle=JSON.parse(await readFile(new URL('./fixtures/specification-coverage/native-v1.json',import.meta.url),'utf8')),
      source=(await readFile(new URL('./helpers/installed-specification-coverage.mjs',import.meta.url),'utf8')).replaceAll('@sdk-name@',packageName)
        .replace("'__COVERAGE_ORACLE__'",JSON.stringify(JSON.stringify(oracle)));
    await run('specification-coverage-values.mjs',source);
  });
  await t.test('installed declarations resolve with NodeNext and reject wrong operations, fields and types', async () => {
    const source = `
      import { createEngine, ENGINE_HELPERS, SingularityFlowError } from '${packageName}';
      import type { EngineInputs, EngineOperation, EngineResult } from '${packageName}';
      import {createRepositoryChangeSetCodec,REPOSITORY_CHANGE_SET_VALUES,sourceTextHunks,SOURCE_TEXT_DIFF_PROFILE} from '${packageName}/changes';
      import type {RepositoryChangeSetCodec,SourceTextDiff,SourceTextHunk} from '${packageName}/changes';
      const diff:SourceTextDiff=sourceTextHunks('before','after',{maximumWork:100});
      const hunk:SourceTextHunk|undefined=diff.hunks[0];const diffProfile:typeof SOURCE_TEXT_DIFF_PROFILE=diff.profile;
      // @ts-expect-error Text comparison cannot discover a checkout or accept a readiness callback.
      sourceTextHunks('before','after',{root:'/checkout',ready:()=>true});
      import {specificationValuePolicies,TEXT_DIGEST_PROFILE,parseVerificationIntent} from '${packageName}/specifications';
      import {javascriptDeclarationPolicies,scanSourceClauseTags} from '${packageName}/specifications';
      import {implementationBindingPolicies,reviewBindings,codeDocumentationPolicies,publicDeclarations,verificationContractPolicies} from '${packageName}/specifications';
      import {sourceTagOriginPolicies,SOURCE_TAG_ORIGIN_VALUES_PROFILE} from '${packageName}/specifications';
      import {repositoryPlanPolicies,REPOSITORY_PLAN_PROFILE} from '${packageName}/specifications';
      import {joinDeclaration,witnessResult,acceptanceWitnessPolicies} from '${packageName}/specifications';
      import type {JoinedTestDeclaration,TestWitnessResult,WitnessRunnerFacts} from '${packageName}/specifications';
      import type {RepositoryPlan,RepositoryPlanValues} from '${packageName}/specifications';
      import {deriveRepositoryPlan} from '${packageName}/specifications/node';
      import type {SourceTagOriginValues,CarriedTagRequest,StoryTagRequest,SourceOriginLineDelta} from '${packageName}/specifications';
      import type {ImplementationBindingResult,ImplementationBindingRequest,ImplementationBindingDecision,PublicDeclaration,VerificationPathSyntax} from '${packageName}/specifications';
      import type {JavaScriptDeclarationResult,JavaScriptTestDeclaration} from '${packageName}/specifications';
      import {scanJavaScriptDeclarations} from '${packageName}/specifications/node';
      const declarationValues=javascriptDeclarationPolicies(Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8:(_text:string)=>'a'.repeat(64)}));
      const declarationResult:JavaScriptDeclarationResult=declarationValues.scanJavaScriptDeclarations("test('works',()=>{});",{sourcePath:'test/example.test.js',framework:'jest'});
      const bindingDecision:ImplementationBindingDecision={clauseId:'VALUE:REQ-001',decision:'exception',reason:'A concrete human-reviewed limitation.'};
      const implementationChoice=reviewBindings({bindings:[],bindingsSha256:'sha256:'+'a'.repeat(64)},[bindingDecision]);
      const publicSymbols:PublicDeclaration[]=publicDeclarations('export function actual(){}','javascript');
      declare const bindingPaths:VerificationPathSyntax;
      declare const witnessFacts:WitnessRunnerFacts;
      const joinedWitness:JoinedTestDeclaration=joinDeclaration({sourcePath:'test/value.test.js',framework:'node:test',suitePath:[],name:'works',line:3,gaps:[]},
        [{name:'works',outcome:'passed',suitePath:[],file:'test/value.test.js',line:3}],{language:'javascript'});
      const observedWitness:TestWitnessResult=witnessResult({clauseId:'VALUE:AC-001',testSource:'test/value.test.js',profile:'node-test-v1'},null);
      const witnessReplay=acceptanceWitnessPolicies(bindingPaths,witnessFacts).discoverAcceptanceWitnessesReplay({id:'code'},{testPaths:['test/value.test.js']});
      // @ts-expect-error Actual command/declaration observations are required, not a readiness flag.
      witnessReplay.next(true);
      // @ts-expect-error Pure witness discovery never discovers a checkout or approval authority.
      acceptanceWitnessPolicies(bindingPaths,witnessFacts).discoverAcceptanceWitnessesReplay({id:'code'},{testPaths:[],root:'/checkout',approved:true});
      declare const witnessEngine:import('${packageName}').Engine;
      witnessEngine.run('phase.test-witnesses.inspect',{phaseId:'code',maximumEntries:1});
      // @ts-expect-error Witness reads cannot be supplied a successful verdict by a model.
      witnessEngine.run('phase.test-witnesses.inspect',{phaseId:'code',ready:true});
      declare const reviewedRepositoryPlan:import('${packageName}/specifications').PlannedSpecificationClaimMap;
      const repositoryValues:Readonly<RepositoryPlanValues>=repositoryPlanPolicies(bindingPaths,[]);
      const repositoryResult:RepositoryPlan|null=repositoryValues.deriveRepositoryPlan('# Legacy',reviewedRepositoryPlan);
      const nodeRepositoryResult:RepositoryPlan|null=deriveRepositoryPlan('# Legacy',reviewedRepositoryPlan);
      // @ts-expect-error Repository values cannot discover a checkout or grant approval.
      repositoryValues.deriveRepositoryPlan('# Plan',reviewedRepositoryPlan,{root:'/checkout',approved:true});
      // @ts-expect-error A path projection is not an approval result.
      const fakeRepository:RepositoryPlan={schemaVersion:1,format:REPOSITORY_PLAN_PROFILE,roots:[],repositories:[],approved:true};
      const origin:SourceTagOriginValues=sourceTagOriginPolicies(bindingPaths,[]),originProfile:typeof SOURCE_TAG_ORIGIN_VALUES_PROFILE=origin.profile;
      const originInput={baseline:'namespace:original-source',occurrences:[],tag:'clause' as const,pathContext:{caseInsensitivePaths:false,governedRoots:[],governedPaths:[]}};
      const originReplay=origin.storyTagLinesReplay(originInput),originStep=originReplay.next();
      const delta:SourceOriginLineDelta={path:'src/app.js',side:'added',line:2,text:'// @clause:VALUE:REQ-001'};
      if(!originStep.done){const requested:StoryTagRequest=originStep.value;originReplay.next([delta]);}
      const carriedReplay=origin.carriedTagIdsReplay({baseline:'namespace:current-baseline',changes:[],occurrences:[],tag:'ac'}),carriedStep=carriedReplay.next();
      if(!carriedStep.done){const requested:CarriedTagRequest=carriedStep.value;carriedReplay.next(new Map<string,string>());}
      // @ts-expect-error Provenance values consume explicit facts, not a checkout or an approval shortcut.
      origin.storyTagLinesReplay({...originInput,root:'/checkout',approved:true});
      // @ts-expect-error A boolean cannot substitute for line/source observations.
      originReplay.next(true);
      // @ts-expect-error Added-line facts require exact current line locations.
      const badDelta:SourceOriginLineDelta={path:'src/app.js',side:'added',line:null,text:'// tag'};
      const bindingValues=implementationBindingPolicies(bindingPaths,Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8:(_text:string)=>'a'.repeat(64)}));
      const requiredTags:string[]=verificationContractPolicies(bindingPaths,Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8:(_text:string)=>'a'.repeat(64)}))
        .requiredAcceptanceFromPlan(['VALUE:AC-001'],{'VALUE:AC-001':{tests:['test/app.js'],steps:['code']}},new Map(),'code');
      const bindingReplay:Generator<ImplementationBindingRequest,ImplementationBindingResult,import('${packageName}/specifications').ImplementationDiffPreview|string|null>
        =bindingValues.implementationBindingsReplay({changeSet:{entries:[]},required:[],tags:[]});
      const bindingStep=bindingReplay.next();if(!bindingStep.done&&bindingStep.value.kind==='implementation-source'){
        const maximumBytes:2097152=bindingStep.value.maximumBytes;bindingReplay.next('An actual observed source body.');}
      codeDocumentationPolicies(bindingPaths).documentationLanguage('src/app.js');
      // @ts-expect-error A value replay cannot acquire a checkout or accept a readiness callback.
      bindingValues.implementationBindingsReplay({changeSet:{entries:[]},root:'/checkout',ready:()=>true});
      // @ts-expect-error Evidence requests consume actual source/region data, never a pass flag.
      bindingReplay.next({ready:true});
      // @ts-expect-error Binding selection is not permission to reject or approve a lifecycle operation.
      reviewBindings({bindings:[],bindingsSha256:'sha256:'+'a'.repeat(64)},[{clauseId:'VALUE:REQ-001',decision:'approve'}]);
      const declaration:JavaScriptTestDeclaration|undefined=scanJavaScriptDeclarations('',{}).declarations[0];
      const tagIds:string[]=scanSourceClauseTags('// @clause:VALUE:REQ-001',{sourcePath:'app.js'}).map(tag=>tag.clauseId);
      // @ts-expect-error Source values cannot receive a checkout or infer retained publication readiness.
      declarationValues.scanJavaScriptDeclarations('',{root:'/checkout',ready:true});
      // @ts-expect-error Exact declaration identity uses a versioned digest capability, not a readiness result.
      javascriptDeclarationPolicies({profile:TEXT_DIGEST_PROFILE,ready:true});
      import type {SpecificationClause,SpecificationIndex,VerificationContract,ClaimTimestampRequest,SpecificationClaimMap} from '${packageName}/specifications';
      import {extractClauses,parseVerificationContracts,normalizeClaimMapReplay,analyzeSpecification,STARTER_CHECKLIST,evaluateApprovalChecklist} from '${packageName}/specifications/node';
      import {specificationAnalysisPolicies,SPECIFICATION_ANALYSIS_DECLARATIONS,TEXT_VALUE_SYNTAX_PROFILE} from '${packageName}/specifications';
      import type {SpecificationAnalysisReport,SpecificationChecklistResult} from '${packageName}/specifications';
      const analysisValues=specificationAnalysisPolicies(Object.freeze({profile:TEXT_VALUE_SYNTAX_PROFILE,sha256Utf8:(_text:string)=>'a'.repeat(64),byteLengthUtf8:(text:string)=>text.length}),
        {profile:SPECIFICATION_ANALYSIS_DECLARATIONS,requiredSections:['Actors'],starterChecklist:STARTER_CHECKLIST});
      const report:SpecificationAnalysisReport=analyzeSpecification('[VALUE:REQ-001] Exact.');
      const checklistResult:SpecificationChecklistResult=evaluateApprovalChecklist({policy:{mode:'enforce'},decisions:[{article:'completeness',decision:'satisfied'}]});
      analysisValues.evaluateSpecificationQuality(report);
      // @ts-expect-error Human checklist choices are a bounded vocabulary, not an approval boolean.
      evaluateApprovalChecklist({decisions:[{article:'completeness',decision:true}]});
      // @ts-expect-error Analysis declarations cannot accept a readiness callback.
      specificationAnalysisPolicies({profile:TEXT_VALUE_SYNTAX_PROFILE,sha256Utf8:()=>'',byteLengthUtf8:()=>0},{profile:SPECIFICATION_ANALYSIS_DECLARATIONS,requiredSections:['Actors'],starterChecklist:STARTER_CHECKLIST,ready:()=>true});
      const specValues=specificationValuePolicies(Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8:(_text:string)=>'a'.repeat(64)}));
      const specClauses:SpecificationClause[]=extractClauses('[VALUE:REQ-001] Exact.');
      const specIndex:SpecificationIndex=specValues.specificationIndexRecord({source:{path:'spec.md',sha256:'a'.repeat(64),bytes:32},clauses:specClauses});
      const specContracts:VerificationContract[]=parseVerificationContracts('');
      parseVerificationIntent('',specClauses);
      import {specificationClaimPolicies,codeCoverageEnforcement,selectActiveSpecRecords} from '${packageName}/specifications';
      import type {SpecificationTextValues,SpecificationCoverageRecords,SpecificationCoverageResult,CandidateSpecificationCoverage} from '${packageName}/specifications';
      declare const coveragePrimitives:SpecificationTextValues;
      const coverageValues=specificationClaimPolicies(bindingPaths,coveragePrimitives);
      const coverageRun=coverageValues.evaluateSpecCoverageReplay({indexes:[],planned:[],observed:[]},[],{coverage:'enforce'},{verifyEvidence:true});
      const coverageStep=coverageRun.next();if(!coverageStep.done)coverageRun.next(false);
      const canonicalCoverageRecords:SpecificationCoverageRecords={indexes:[{schemaVersion:1,workId:'VALUE',phase:'scope',generation:1,clauses:[{id:'VALUE:REQ-001'}]}],
        planned:[{schemaVersion:2,kind:'planned',recordedAt:'2026-01-01T00:00:00.000Z',claims:{'VALUE:REQ-001':{fulfillment:'new',expectedPaths:['src/value.js'],tests:['test/value.test.js']}}}],
        observed:[{schemaVersion:2,kind:'observed',claims:{'VALUE:REQ-001':{verdict:'matched',observedPaths:['src/value.js'],testResults:['test/value.test.js'],commits:[],deviation:null}}}]};
      coverageValues.evaluateSpecCoverageReplay(canonicalCoverageRecords);
      const coverageMode:'enforce'|'qualified-ending'|null=codeCoverageEnforcement({coverage:'enforce'});
      selectActiveSpecRecords({indexes:[]},{workItem:{id:'VALUE'}});
      // @ts-expect-error Coverage consumes exact existence observations, never a readiness verdict.
      coverageRun.next({ready:true});
      // @ts-expect-error Pure coverage never discovers a physical checkout.
      coverageValues.evaluateSpecCoverageReplay({},[],{},{root:'/checkout'});
      const candidateCoverage=coverageValues.candidateSpecificationCoverageReplay({}, {}, {}, {changeSet:{entries:[]}},
        {pathContext:{caseInsensitivePaths:false,governedRoots:[],governedPaths:[]}});
      // @ts-expect-error Candidate observations require complete original record sets.
      candidateCoverage.next({ready:true});
      const claimReplay:Generator<ClaimTimestampRequest,SpecificationClaimMap,string>=normalizeClaimMapReplay({claims:{}},{kind:'planned'});
      const claimStep=claimReplay.next();
      if(!claimStep.done)claimReplay.next('2026-02-03T04:05:06.789Z');
      // @ts-expect-error Clock checkpoints accept the original timestamp, not approval/readiness data.
      claimReplay.next({approved:true});
      // @ts-expect-error An index value cannot accept or claim approval authority.
      specValues.specificationIndexRecord({source:{path:'spec.md',sha256:'a'.repeat(64),bytes:32},clauses:specClauses,approved:true});
      // @ts-expect-error The digest capability is an explicit versioned value binding.
      specificationValuePolicies({profile:'arbitrary',sha256Utf8:()=> 'a'.repeat(64)});
      import { ARTIFACT_TEMPLATE_TOKENS, renderArtifactTemplateText, validateArtifactTemplateText,
        artifactBytesAreText, artifactContentObservation, inspectRequiredArtifactObservation, inspectBinaryArtifactSize } from '${packageName}/artifacts';
      import type { ArtifactContentPhase, ArtifactContentFinding } from '${packageName}/artifacts';
      import { createFilesystemNamespaceStore } from '${packageName}/storage/filesystem';
      import { createSqliteNamespaceStore } from '${packageName}/storage/sqlite';
      import { createApplicationNamespaceStore } from '${packageName}/storage/application';
      import { createSqliteContentStore } from '${packageName}/storage/sqlite-content';
      import { createNamespaceReadEngine, namespaceReadRecord, projectNamespaceLifecycleReadState } from '${packageName}/hosts/namespace-reader';
      import { createNamespaceProjectEngine } from '${packageName}/hosts/namespace-project';
      import { createNamespaceConfigurationEngine } from '${packageName}/hosts/namespace-configuration';
      import { createNamespaceStoryEngine } from '${packageName}/hosts/namespace-story';
      import { createNamespaceSourceEngine } from '${packageName}/hosts/namespace-source';
      import { createNamespacePreparationEngine } from '${packageName}/hosts/namespace-preparation';
      import { createNamespacePublicationEngine,NAMESPACE_PUBLICATION_PROFILE,NAMESPACE_CHECKED_PUBLICATION_PROFILE,NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE,NAMESPACE_POLICY_PUBLICATION_PROFILE } from '${packageName}/hosts/namespace-publication';
      const specificationPublicationProfile:'sflow-specification-publication/v1'=NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE;
      const policyPublicationProfile:'sflow-policy-publication/v1'=NAMESPACE_POLICY_PUBLICATION_PROFILE;
      import { createNamespaceSubmissionEngine,NAMESPACE_SUBMISSION_PROFILE,NAMESPACE_SUBMISSION_DECISION_PROFILE,NAMESPACE_CHECKED_SUBMISSION_PROFILE } from '${packageName}/hosts/namespace-submission';
      import { createNamespaceApprovalEngine,NAMESPACE_APPROVAL_PROFILE,NAMESPACE_ROUTED_APPROVAL_PROFILE } from '${packageName}/hosts/namespace-approval';
      import { createNamespaceRoutingChoiceEngine,NAMESPACE_ROUTING_CHOICE_PROFILE } from '${packageName}/hosts/namespace-routing-choice';
      import {createNamespaceEngine} from '${packageName}/hosts/namespace-engine';
      import type {NamespaceEngineOptions} from '${packageName}/hosts/namespace-engine';
      import {createNamespacePhaseChecksEngine} from '${packageName}/hosts/namespace-checks';
      import {createNamespaceSourceInspectionEngine} from '${packageName}/hosts/namespace-source-inspection';
      import {createNamespaceSourceRetentionEngine} from '${packageName}/hosts/namespace-source-retention';
      import { createFilesystemSourceUnit } from '${packageName}/sources/filesystem';
      import {createNamespaceSourceBaselineEngine} from '${packageName}/hosts/namespace-source-baseline';
      import {createNamespaceDeliveryInspectionEngine} from '${packageName}/hosts/namespace-delivery-inspection';
      import {createNamespaceSourceControlEngine} from '${packageName}/hosts/namespace-source-control';
      import type { SourceUnit,SourceDescriptor } from '${packageName}/source';
      import type {SourceControlReader,SourceControlReaderDescriptorV1,SourceControlSubject} from '${packageName}/source-control';
      import {createNodeGitSourceControlReader} from '${packageName}/sources/git';
      import {captureExecutionUnit,EXECUTION_UNIT_CONTRACT} from '${packageName}/execution';
      import type {ExecutionUnit,AgentTaskInput,ExecutionCandidate} from '${packageName}/execution';
      import {createDeterministicTranslatorExecutionUnit,createAgentTaskContract,createGenericProcessExecutionUnit} from '${packageName}/execution/node';
      import {createNamespaceSgosOperationalStore} from '${packageName}/execution/storage/namespace';
      import {createDurableExecutionUnit,createNodeExecutionOwner} from '${packageName}/execution/runtime';
      import {createNodeTestReportCodec} from '${packageName}/testing/node';
      import type {TestReportCodec,ParsedTestReport} from '${packageName}/testing/reports';
      import {createNodeCheckExecutionUnit} from '${packageName}/testing/execution';
      import type {OperationalStore,OperationalState} from '${packageName}/execution/storage';
      import type { ContentStore, ContentReference } from '${packageName}/content';
      import { emptyNamespaceState, NAMESPACE_JOURNAL_PORT } from '${packageName}/storage/journal';
      import type { NamespaceStore, NamespaceTransaction } from '${packageName}/namespace';
      declare const runtimeMetadata:NamespaceStore;declare const runtimeContent:ContentStore;declare const unitPort:ExecutionUnit;
      declare const gitSource:SourceDescriptor;
      const gitReader:Promise<SourceControlReader>=createNodeGitSourceControlReader({id:'git',root:'/explicit',source:gitSource,baselineCommit:'exact-commit',
        git:{executable:'/explicit/git',executableSha256:'sha256:exact'},authorizeCapture:(descriptor,subject)=>subject.phase==='implementation'});
      const gitSubject:SourceControlSubject={workId:'example',phase:'implementation',generation:1,generationIntentId:null};
      gitReader.then(reader=>reader.capture(gitSubject,{signal:null}));
      const legacyReader=createNodeGitSourceControlReader({id:'legacy',root:'/explicit',source:gitSource,baselineCommit:'exact',
        git:{executable:'/explicit/git',executableSha256:'sha256:exact'},authorizeCapture:(descriptor:SourceControlReaderDescriptorV1)=>descriptor.contract==='sflow-source-control-reader/v1'});
      legacyReader.then(async reader=>{const contract:'sflow-source-control-reader/v1'=reader.descriptor.contract;
        const answer=await reader.capture(gitSubject);const version:1=answer.observation.schemaVersion;
        // @ts-expect-error Omitted originCommit preserves the v1 capability type.
        reader.descriptor.originRevision;});
      const boundOriginReader=createNodeGitSourceControlReader({id:'exact-origins',root:'/explicit',source:gitSource,baselineCommit:'generation',originCommit:'story',
        git:{executable:'/explicit/git',executableSha256:'sha256:exact'},authorizeCapture:()=>true});
      boundOriginReader.then(async reader=>{const origin:string=reader.descriptor.originRevision;
        const answer=await reader.capture(gitSubject);const version:2=answer.observation.schemaVersion;});
      const originReader:Promise<SourceControlReader>=createNodeGitSourceControlReader({id:'origins',root:'/explicit',source:gitSource,
        baselineCommit:'exact-generation',originCommit:'exact-story-origin',git:{executable:'/explicit/git',executableSha256:'sha256:exact'},authorizeCapture:()=>true});
      originReader.then(async reader=>{
        if(reader.descriptor.contract==='sflow-source-control-reader/v2'){const original:string=reader.descriptor.originRevision;}
        // @ts-expect-error A v1 descriptor does not claim first-Story origin evidence.
        if(reader.descriptor.contract==='sflow-source-control-reader/v1')reader.descriptor.originRevision;
        const answer=await reader.capture(gitSubject);if(answer.observation.schemaVersion===2){const position:number|undefined=answer.observation.origin.patch[0]?.hunks[0]?.afterStart;}
      });
      // @ts-expect-error A source origin is an explicit revision, not a readiness flag.
      createNodeGitSourceControlReader({id:'origins',root:'/explicit',source:gitSource,baselineCommit:'exact',originCommit:true,git:{executable:'/git',executableSha256:'sha256:exact'},authorizeCapture:()=>true});
      // @ts-expect-error Local Git access requires an explicit authorization capability.
      createNodeGitSourceControlReader({id:'git',root:'/explicit',source:gitSource,baselineCommit:'exact-commit',git:{executable:'/git',executableSha256:'sha256:exact'}});
      // @ts-expect-error Fixed Git commands cannot be replaced by operation data.
      gitReader.then(reader=>reader.capture({...gitSubject,argv:['push']}));
      const changeCodec:RepositoryChangeSetCodec=createRepositoryChangeSetCodec(Object.freeze({profile:REPOSITORY_CHANGE_SET_VALUES,
        sha256Text:(text:string)=>text,compareUtf8:(a:string,b:string)=>a===b?0:a<b?-1:1}));
      const changeEntries=[changeCodec.withEntryIdentity({newPath:'src/value.js',status:'added'})];
      const candidateIntegrity:boolean=changeCodec.verifyRepositoryChangeSetIntegrity({entries:changeEntries}).valid;
      const observedFailureId=changeCodec.verifyRepositoryChangeSetIntegrity({entries:[{changeId:123}]}).entryFailures[0]??'';
      // @ts-expect-error An invalid supplied record may retain a non-string identity; inspect it before display.
      const assumedFailureId:string=observedFailureId;
      // @ts-expect-error Git wire decoding is owned by a source-control adapter.
      changeCodec.parseRawDiff('');
      // @ts-expect-error Hashing must be an explicitly bound callable capability.
      createRepositoryChangeSetCodec({profile:REPOSITORY_CHANGE_SET_VALUES,sha256Text:true,compareUtf8:()=>0});
      const localCheckPromise:Promise<ExecutionUnit>=createNodeCheckExecutionUnit({id:'declared-check',projectId:'example',repositoryId:'application',root:'/explicit',content:runtimeContent,
        command:{executable:'/explicit/node',executableSha256:'sha256:abc',arguments:['--test'],environment:{}},
        report:{adapter:'node-tap',files:[]},authorizeCommand:()=>true});
      declare const phaseCheckOptions:NamespaceEngineOptions;
      createNamespaceEngine(phaseCheckOptions).run('phase.enter',{phaseId:'review',compose:true});
      createNamespaceEngine(phaseCheckOptions).run('phase.context.read',{workId:'example',phaseId:'review',contextSha256:'exact-context',resourceId:'issued-resource',maximumBytes:4000,representation:'base64',offset:256});
      // @ts-expect-error Context bodies require the exact manifest digest and issued resource handle.
      createNamespaceEngine(phaseCheckOptions).run('phase.context.read',{workId:'example',phaseId:'review',resourceId:'issued-resource'});
      // @ts-expect-error Context reads accept bounded representations, never a model prompt or file path.
      createNamespaceEngine(phaseCheckOptions).run('phase.context.read',{workId:'example',phaseId:'review',contextSha256:'exact-context',resourceId:'issued-resource',representation:'prompt'});
      // @ts-expect-error Byte offsets are numeric, never shell arguments.
      createNamespaceEngine(phaseCheckOptions).run('phase.context.read',{workId:'example',phaseId:'review',contextSha256:'exact-context',resourceId:'issued-resource',offset:'20'});
      createNamespaceEngine(phaseCheckOptions).run('clarification.status',{phaseId:'review'});
      createNamespaceEngine(phaseCheckOptions).run('clarification.record',{operationId:'answer-checkpoint',workId:'example',phaseId:'review',
        contextSha256:'exact-reviewed-context',responses:[{question:'Scope?',answer:'The human scope.'}],replace:true,reason:'Reviewed replacement.'});
      // @ts-expect-error A checkpoint needs an exact reviewed context digest.
      createNamespaceEngine(phaseCheckOptions).run('clarification.record',{operationId:'answer',workId:'example',phaseId:'review',responses:[]});
      // @ts-expect-error Stored readiness is not a substitute for human answers.
      createNamespaceEngine(phaseCheckOptions).run('clarification.record',{operationId:'answer',workId:'example',phaseId:'review',contextSha256:'exact',responses:[],ready:true});

      createNamespaceEngine(phaseCheckOptions).run('phase.source.inspect',{phaseId:'review',maximumEntries:25});
      createNamespaceEngine(phaseCheckOptions).run('phase.source.retain',{operationId:'retain-code',workId:'example',phaseId:'review'});
      const retentionFactory:typeof createNamespaceSourceRetentionEngine=createNamespaceSourceRetentionEngine;
      const baselineFactory:typeof createNamespaceSourceBaselineEngine=createNamespaceSourceBaselineEngine;
      createNamespaceEngine(phaseCheckOptions).run('source.baseline.retain',{operationId:'archive-source',workId:'example',sourceBindingId:'selected-source'});
      // @ts-expect-error Baseline selection must name an accepted source-binding operation.
      createNamespaceEngine(phaseCheckOptions).run('source.baseline.retain',{operationId:'archive-source',workId:'example',sourceBindingId:null});
      // @ts-expect-error Retention selection comes from the actual generation, never caller-supplied file paths.
      createNamespaceEngine(phaseCheckOptions).run('phase.source.retain',{operationId:'retain-code',workId:'example',phaseId:'review',paths:['private.txt']});
      // @ts-expect-error A source query cannot accept caller-supplied readiness or a replacement source path.
      createNamespaceEngine(phaseCheckOptions).run('phase.source.inspect',{ready:true,path:'/other'});
      const inspectFactory:typeof createNamespaceSourceInspectionEngine=createNamespaceSourceInspectionEngine;
      const deliveryInspectFactory:typeof createNamespaceDeliveryInspectionEngine=createNamespaceDeliveryInspectionEngine;
      createNamespaceDeliveryInspectionEngine({...phaseCheckOptions,localRecords:runtimeMetadata,localContent:runtimeContent}).run('phase.delivery.inspect',{phaseId:'review',maximumEntries:25});
      createNamespaceEngine(phaseCheckOptions).run('phase.delivery.inspect',{phaseId:'review'});
      createNamespaceEngine(phaseCheckOptions).run('phase.delivery.inspect',{phaseId:'review',includeImplementation:true});
      // @ts-expect-error Implementation-region inspection is an explicit boolean capability request.
      createNamespaceEngine(phaseCheckOptions).run('phase.delivery.inspect',{phaseId:'review',includeImplementation:'yes'});
      // @ts-expect-error Source inventory does not implicitly acquire implementation-region inspection.
      createNamespaceEngine(phaseCheckOptions).run('phase.source.inspect',{phaseId:'review',includeImplementation:true});
      createNamespaceEngine(phaseCheckOptions).run('phase.source-control.retain',{operationId:'retain-origin',workId:'example',phaseId:'review'});
      createNamespaceSourceControlEngine({...phaseCheckOptions,localRecords:runtimeMetadata,localContent:runtimeContent,sourceControlReaders:[]});
      // @ts-expect-error Required source/control retention identities cannot be null.
      createNamespaceEngine(phaseCheckOptions).run('phase.source-control.retain',{operationId:'retain-origin',workId:'example',phaseId:null});
      // @ts-expect-error Observations are captured by an explicit capability, never operation input.
      createNamespaceEngine(phaseCheckOptions).run('phase.source-control.retain',{operationId:'retain-origin',workId:'example',phaseId:'review',observation:{}});
      // @ts-expect-error Delivery observations cannot accept a caller-supplied publication verdict.
      createNamespaceEngine(phaseCheckOptions).run('phase.delivery.inspect',{phaseId:'review',ready:true});
      createNamespacePhaseChecksEngine(phaseCheckOptions).run('phase.checks.run',{operationId:'run-checks',workId:'example',phaseId:'review'});
      // @ts-expect-error Replacement commands do not enter the registered phase-check operation.
      createNamespacePhaseChecksEngine(phaseCheckOptions).run('phase.checks.run',{operationId:'run-checks',workId:'example',phaseId:'review',argv:['node','other']});
      // @ts-expect-error Local checks require an explicit immutable content store.
      createNodeCheckExecutionUnit({id:'missing-content',root:'/explicit',projectId:'example',repositoryId:'application',command:{executable:'/node',executableSha256:'sha256:abc',arguments:[]},report:{adapter:'node-tap',files:[]},authorizeCommand:()=>true});
      const reports:TestReportCodec=createNodeTestReportCodec();
      const parsed:ParsedTestReport=reports.replayTestReports('node-tap',[{contents:new Uint8Array()}]);
      // @ts-expect-error Report byte inputs are explicit data, never an implicit filesystem path object.
      reports.replayTestReports('node-tap',[{path:'/another/report'}]);
      const operational:OperationalStore=createNamespaceSgosOperationalStore({records:runtimeMetadata,content:runtimeContent,scope:{projectId:'example'},storeId:'execution'});
      const operationalState:Promise<OperationalState>=operational.read();
      const durable:ExecutionUnit=createDurableExecutionUnit({unit:unitPort,store:operational,content:runtimeContent,scope:{projectId:'example'},
        owner:createNodeExecutionOwner({hostId:'declared-host'}),clock:{now:()=>new Date().toISOString()}});
      // @ts-expect-error A durable execution needs a live owner capability, not a stored lease object.
      createDurableExecutionUnit({unit:unitPort,store:operational,content:runtimeContent,scope:{projectId:'example'},clock:{now:()=>new Date().toISOString()}});
      // @ts-expect-error Runtime persistence requires an explicit immutable-content port.
      createNamespaceSgosOperationalStore({records:runtimeMetadata,scope:{projectId:'example'},storeId:'execution'});
      // @ts-expect-error Operational transactions do not expose lifecycle approval operations.
      operational.transact({expectedRevision:0,expectedStateSha256:'sha256:fixture',changes:[{op:'approve',key:'phase'}]});
      const engine=createEngine({ports:{publication:{load:async()=>{throw new Error('host');},retained:async()=>null,
        prepare:async()=>null,commit:async()=>null,finish:async()=>null}}});
      const execution:ExecutionUnit=captureExecutionUnit(createDeterministicTranslatorExecutionUnit());
      const executionManifest=execution.descriptor();
      const taskInput:AgentTaskInput={taskId:'task',processId:'process',instructionId:'instruction',objective:'A bounded task',
        acceptanceClauses:[],policySnapshotSha256:'sha256:policy',programSha256:'sha256:program',inputs:[],readScope:[],writeScope:[],forbiddenScope:[],
        allowedDevices:[],environmentManifestSha256:'sha256:environment',candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],
        budgets:{activeMinutes:1,modelInvocations:0,touchedResources:0},stopConditions:[],executionUnitManifestSha256:executionManifest.manifestSha256};
      const taskContract=createAgentTaskContract(taskInput);const handle=execution.start(taskContract);
      const candidate:Promise<ExecutionCandidate>=handle.then(value=>execution.collect(value));
      // @ts-expect-error A partial object cannot implement the execution-unit port.
      captureExecutionUnit({descriptor:()=>executionManifest});
      // @ts-expect-error Execution constructors need an explicit authorization binding.
      createGenericProcessExecutionUnit(executionManifest,{root:'/explicit/working-directory'});
      // @ts-expect-error Operational task scope cannot supply phase approval authority.
      execution.start({...taskContract,approval:true});
      // @ts-expect-error Stop reasons are text.
      handle.then(value=>execution.requestStop(value,{reason:true}));
      const artifact:string=renderArtifactTemplateText(ARTIFACT_TEMPLATE_TOKENS.workId,{id:'scope'},{id:'example'});
      validateArtifactTemplateText(artifact);
      const contentPhase:ArtifactContentPhase={id:'review',status:'in_progress',generation:0,requiredArtifact:{minimumBytes:20,
        validation:{requiredHeadings:['Evidence']}}};
      const observation=artifactContentObservation('# Result\\n\\n## Evidence\\nActual content.');
      const contentFindings:ArtifactContentFinding[]=inspectRequiredArtifactObservation(observation,contentPhase,{fingerprint:'sha256:actual-host-digest'});
      artifactBytesAreText(new Uint8Array([0,255]));inspectBinaryArtifactSize(2,contentPhase);
      // @ts-expect-error Artifact classification consumes actual bytes, never a path.
      artifactBytesAreText('/another/artifact.pdf');
      // @ts-expect-error An observation requires an explicit adapter-computed normalized digest.
      inspectRequiredArtifactObservation(observation,contentPhase,{});
      // @ts-expect-error A normalized fingerprint carries its hash algorithm tag.
      inspectRequiredArtifactObservation(observation,contentPhase,{fingerprint:'unbound'});
      // @ts-expect-error A phase needs an explicit logical identifier, never a physical root.
      renderArtifactTemplateText('',{root:'/another/checkout'},{});
      // @ts-expect-error Artifact token values are text, not claimed readiness objects.
      renderArtifactTemplateText('',{id:'scope'},{inputs:{ready:true}});
      const check:Promise<EngineResult<'phase.publish'>>=engine.publishPhase({workId:'example'});
      const operation:EngineOperation=ENGINE_HELPERS.publishPhase;
      const input:EngineInputs['phase.enter']={workId:'example',compose:true};
      engine.run('phase.enter',input);
      engine.run('workflow.assets',{workflowIds:['story:feature']});
      engine.run('story.status',{workId:'example'});
      engine.run('decision.context',{workId:'example'});
      engine.run('decision.choose',{workId:'example',expected:'a'.repeat(16),option:'continue',reason:'Human reviewed this route.'});
      // @ts-expect-error A read-only context accepts no human answer.
      engine.run('decision.context',{workId:'example',option:'continue'});
      // @ts-expect-error A routing choice takes a logical question key, not an actor grant.
      engine.run('decision.choose',{workId:'example',principalId:'administrator'});
      const choiceProfile:'sflow-human-routing-choice/v1'=NAMESPACE_ROUTING_CHOICE_PROFILE;
      void createNamespaceRoutingChoiceEngine;void choiceProfile;
      const composedOptions:NamespaceEngineOptions={records:{} as NamespaceStore,content:{} as ContentStore,
        scope:{projectId:'example'},workId:'example',authority:{id:'application',epoch:1},clock:{now:()=>new Date().toISOString()},
        access:{current:()=>({projectId:'example',principalId:'human',actorKind:'human',agentId:null,
          identity:{name:'Reviewer',email:'reviewer@example.test',login:null},permissions:[]})}};
      const composed=createNamespaceEngine(composedOptions);composed.run('decision.context');
      // @ts-expect-error A working store uses explicit content/record ports, never a laptop path.
      createNamespaceEngine({...composedOptions,working:{records:composedOptions.records,content:'/a/path'}});
      // @ts-expect-error A composed Engine always has one explicit Story identity.
      createNamespaceEngine({records:composedOptions.records,content:composedOptions.content});
      engine.run('story.guide',{workId:'example'});
      engine.run('project.enroll',{operationId:'enroll-1'});
      const configuration:EngineInputs['configuration.approve']={operationId:'approve-configuration',source:{namespace:'config',sha256:'a'.repeat(64),bytes:1},expectedRevision:null,confirm:'a'.repeat(64),reason:'Reviewed exact content.'};
      engine.run('configuration.approve',configuration);
      const creation:EngineInputs['story.create']={operationId:'create-1',workId:'example',title:'Example',workTypeId:'feature',configurationId:'approve-configuration',source:{namespace:'state',sha256:'a'.repeat(64),bytes:1}};
      engine.run('story.create',creation);
      const sourceBinding:EngineInputs['source.bind']={operationId:'bind-1',workId:'example',expectedRevision:'opaque',repositories:['app'],reason:'Actual source checkout.'};
      engine.run('source.bind',sourceBinding);
      engine.run('phase.draft.read',{workId:'example',phaseId:'review',maximumBytes:512});
      const draft:EngineInputs['phase.draft.write']={operationId:'draft-1',workId:'example',phaseId:'review',expectedRevision:'opaque',
        content:{namespace:'local',sha256:'a'.repeat(64),bytes:1},reason:'Preserve the authored bytes.'};
      engine.run('phase.draft.write',draft);
      engine.run('phase.draft.rebase',{operationId:'rebase-1',workId:'example',phaseId:'review',expectedRevision:'opaque',confirm:'a'.repeat(64),reason:'Review the new basis.'});
      // @ts-expect-error Authored bytes use a local content reference, never a laptop path.
      engine.run('phase.draft.write',{...draft,content:'/another/draft.md'});
      // @ts-expect-error A private write requires its expected revision and stable operation ID.
      engine.run('phase.draft.write',{});
      // @ts-expect-error Read budgets are integer byte counts, never CLI strings.
      engine.run('phase.draft.read',{maximumBytes:'512'});
      // @ts-expect-error Physical roots belong to the source-unit constructor, not an operation.
      engine.run('source.bind',{...sourceBinding,root:'/another/checkout'});
      // @ts-expect-error Repository selection is a list of logical IDs.
      engine.run('source.bind',{...sourceBinding,repositories:'app'});
      // @ts-expect-error The exact expected lifecycle revision is mandatory.
      engine.run('source.bind',{});
      // @ts-expect-error Story creation requires the exact immutable source and configuration ID.
      engine.run('story.create',{});
      // @ts-expect-error An immutable source reference cannot be a laptop path.
      engine.run('story.create',{...creation,source:'/another/file'});
      // @ts-expect-error A Story ID is separate from a checkout branch, which is not a creation input.
      engine.run('story.create',{...creation,branch:'feature/example'});
      // @ts-expect-error Exact configuration approval inputs and confirmation are mandatory.
      engine.run('configuration.approve',{});
      // @ts-expect-error Source is an immutable content binding, never a laptop path.
      engine.run('configuration.approve',{...configuration,source:'/another/file'});
      // @ts-expect-error The trusted application, never operation inputs, supplies reviewer identity.
      engine.run('configuration.approve',{...configuration,principalId:'administrator'});
      // @ts-expect-error Enrollment requires a stable operation identity.
      engine.run('project.enroll',{});
      // @ts-expect-error Required enrollment inputs cannot be omitted altogether.
      engine.run('project.enroll');
      // @ts-expect-error The trusted host binds enrollment identity and permissions.
      engine.run('project.enroll',{operationId:'enroll-1',principalId:'administrator'});
      // @ts-expect-error Review and authoring observations come from the trusted port.
      engine.run('story.guide',{sourceReviewEvidence:{status:'ready'}});
      // @ts-expect-error Native branch/Jira alias resolution belongs to the host composition.
      engine.run('story.status',{reference:'feature/example'});
      // @ts-expect-error Ordinary status cannot fetch or mutate the Story.
      engine.run('story.status',{fetch:true});
      // @ts-expect-error Unsupported operation name.
      engine.run('phase.teleport',{});
      // @ts-expect-error CLI host flag is not an engine input.
      engine.publishPhase({root:'/another'});
      // @ts-expect-error Checks require a boolean.
      engine.submitPhase({runChecks:'true'});
      engine.rejectPhase({workId:'example',phaseId:'review',target:'design',members:['design.md'],clauseIds:['REQ-001'],repair:true});
      // @ts-expect-error identity is bound by a trusted port, never operation input
      engine.rejectPhase({actor:{login:'admin'}});
      // @ts-expect-error member selections are exact string arrays
      engine.rejectPhase({members:'design.md'});
      engine.run('phase.inputs',{workId:'example',phaseId:'review',dryRun:true});
      // @ts-expect-error preview mode is a boolean, never a CLI string
      engine.run('phase.inputs',{dryRun:'true'});
      // @ts-expect-error native records and source bodies are not operation inputs
      engine.run('phase.inputs',{records:[]});
      // @ts-expect-error A witness expected binding is an opaque string, not a request object.
      engine.run('decision.witness',{expectedContext:{workId:'different'}});
      // @ts-expect-error Scope requires a project identity.
      const badScope:Parameters<NamespaceStore['read']>[0]={project:'other'};
      const tx:NamespaceTransaction={operationId:'example',preconditions:[],changes:[],events:[]};
      const filesystem:Promise<NamespaceStore>=createFilesystemNamespaceStore({root:'/application',binding:{kind:'shared'}});
      const database=createSqliteNamespaceStore({filename:'/application/records.db',binding:{kind:'shared'}});
      const unavailable=new SingularityFlowError('missing',{code:'UNAVAILABLE',cause:new Error('detail')});
      const reference:ContentReference={namespace:'state',sha256:'a'.repeat(64),bytes:1};
      const head=namespaceReadRecord('head',{projectId:'example',workId:'example',state:reference,policy:{...reference,namespace:'config'},documents:reference});
      const lifecycleRead:Readonly<Record<string,import('${packageName}/namespace').JsonValue>>=projectNamespaceLifecycleReadState({currentPhase:null,status:'closed'});
      // @ts-expect-error Read projections are immutable descriptions, never lifecycle writers.
      lifecycleRead.status='approved';
      function readHost(records:NamespaceStore,content:ContentStore){return createNamespaceReadEngine({records,content,scope:{projectId:'example'},workId:'example'});}
      function projectHost(records:NamespaceStore,content:ContentStore){return createNamespaceProjectEngine({records,content,scope:{projectId:'example'},
        authority:{id:'application-authority',epoch:1},access:{current:()=>({projectId:'example',principalId:'application-owner',permissions:['project.enroll']})},
        clock:{now:()=> '2026-11-08T00:00:00.000Z'}});}
      function configurationHost(records:NamespaceStore,content:ContentStore){return createNamespaceConfigurationEngine({records,content,scope:{projectId:'example'},
        authority:{id:'application-authority',epoch:1},access:{current:()=>({projectId:'example',principalId:'human-reviewer',permissions:['configuration.approve'],actorKind:'human'})},
        clock:{now:()=> '2026-11-08T00:00:00.000Z'}});}
      function approvalHost(records:NamespaceStore,content:ContentStore) {
        const routedProfile:'sflow-primary-document-approval/v2'=NAMESPACE_ROUTED_APPROVAL_PROFILE;void routedProfile;
        const options={records,content,scope:{projectId:'example'},workId:'example',authority:{id:'application-authority',epoch:1},
          access:{current:()=>({projectId:'example',principalId:'human-reviewer',actorKind:'human' as const,agentId:null,
            permissions:['phase.approve'],identity:{name:'Example reviewer',email:'reviewer@example.test'}})},
          clock:{now:()=> '2026-11-08T00:00:00.000Z'}};
        createNamespaceApprovalEngine(options);
        // @ts-expect-error Human approval has no ambient access or clock fallback.
        createNamespaceApprovalEngine({records,content,scope:options.scope,workId:options.workId,authority:options.authority});
        return createNamespaceApprovalEngine(options);
      }
      function storyHost(records:NamespaceStore,content:ContentStore){return createNamespaceStoryEngine({records,content,scope:{projectId:'example'},workId:'example',
        authority:{id:'application-authority',epoch:1},access:{current:()=>({projectId:'example',principalId:'human-reviewer',permissions:['story.create'],actorKind:'human',identity:{name:'Example reviewer',email:'reviewer@example.test'}})},
        clock:{now:()=> '2026-11-08T00:00:00.000Z'}});}
      async function sourceHost(records:NamespaceStore,content:ContentStore,root:string) {
        const unit:SourceUnit=await createFilesystemSourceUnit({root,id:'checkout',projectId:'example',repositoryId:'app'});
        return createNamespaceSourceEngine({records,content,scope:{projectId:'example'},workId:'example',authority:{id:'application-authority',epoch:1},sources:[unit],
          access:{current:()=>({projectId:'example',principalId:'source-coordinator',actorKind:'human',permissions:['source.bind'],identity:{name:'Example coordinator',email:'coordinator@example.test'}})},
          clock:{now:()=> '2026-11-08T00:00:00.000Z'}});
      }
      function preparationHost(records:NamespaceStore,content:ContentStore,localRecords:NamespaceStore,localContent:ContentStore) {
        const options={records,content,localRecords,localContent,scope:{projectId:'example'},workId:'example',authority:{id:'application-authority',epoch:1},
          access:{current:()=>({projectId:'example',principalId:'human-reviewer',actorKind:'human' as const,agentId:'analyst',
            permissions:['phase.prepare','phase.draft.read','phase.draft.write','phase.draft.rebase'],identity:{name:'Example reviewer',email:'reviewer@example.test'}})},
          clock:{now:()=> '2026-11-08T00:00:00.000Z'}};
        createNamespacePreparationEngine(options);
        // @ts-expect-error Private metadata and content ports must be supplied explicitly.
        createNamespacePreparationEngine({records,content,scope:options.scope,workId:options.workId,authority:options.authority,access:options.access,clock:options.clock});
        return createNamespacePreparationEngine(options);
      }
      function publicationHost(records:NamespaceStore,content:ContentStore,localRecords:NamespaceStore,localContent:ContentStore) {
        const options={records,content,localRecords,localContent,scope:{projectId:'example'},workId:'example',authority:{id:'application-authority',epoch:1},
          access:{current:()=>({projectId:'example',principalId:'human-reviewer',actorKind:'human' as const,agentId:'analyst',
            permissions:['phase.publish'],identity:{name:'Example reviewer',email:'reviewer@example.test'}})},
          clock:{now:()=> '2026-11-08T00:00:00.000Z'}};
        const profile:'sflow-primary-document-publication/v1'=NAMESPACE_PUBLICATION_PROFILE;
        const checkedProfile:'sflow-primary-document-publication/v2'=NAMESPACE_CHECKED_PUBLICATION_PROFILE;
        const published:Promise<EngineResult<'phase.publish'>>=createNamespacePublicationEngine(options).publishPhase({phaseId:'review'});
        // @ts-expect-error Shared publication still needs its explicit private authored-byte ports.
        createNamespacePublicationEngine({records,content,scope:options.scope,workId:options.workId,authority:options.authority,access:options.access,clock:options.clock});
        // @ts-expect-error Operation inputs cannot claim their own permission or supply an authenticated actor.
        createNamespacePublicationEngine(options).publishPhase({phaseId:'review',actor:{principalId:'administrator'}});
        return [profile,checkedProfile,published];
      }
      function submissionHost(records:NamespaceStore,content:ContentStore) {
        const options={records,content,scope:{projectId:'example'},workId:'example',authority:{id:'application-authority',epoch:1},
          access:{current:()=>({projectId:'example',principalId:'human-reviewer',actorKind:'human' as const,agentId:'analyst',permissions:['phase.submit'],
            identity:{name:'Example reviewer',email:'reviewer@example.test'}})},clock:{now:()=> '2026-11-08T00:00:00.000Z'}};
        const profile:'sflow-primary-document-submission/v1'=NAMESPACE_SUBMISSION_PROFILE;
        const decisionProfile:'sflow-primary-document-submission/v2'=NAMESPACE_SUBMISSION_DECISION_PROFILE;
        const submission:Promise<EngineResult<'phase.submit'>>=createNamespaceSubmissionEngine(options).submitPhase({phaseId:'review'});
        // @ts-expect-error Submission access is authenticated by the construction-time port.
        createNamespaceSubmissionEngine(options).submitPhase({phaseId:'review',actor:{principalId:'administrator'}});
        // @ts-expect-error Shared metadata and content connections are explicit requirements.
        createNamespaceSubmissionEngine({scope:options.scope,workId:options.workId,authority:options.authority,access:options.access,clock:options.clock});
        return [profile,decisionProfile,submission];
      }
      void [check,operation,tx,filesystem,database,unavailable,createApplicationNamespaceStore,emptyNamespaceState,NAMESPACE_JOURNAL_PORT,contentFindings];
      void [head,readHost,projectHost,configurationHost,storyHost,sourceHost,preparationHost,publicationHost,submissionHost,createSqliteContentStore];
    `;
    const file = path.join(consumer, 'types.mts'); await writeFile(file, source);
    const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: false, types: [],
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
    const declared = await readFile(path.join(consumer, 'node_modules', packageName, 'dist/index.d.mts'), 'utf8');
    for (const { id, inputFields, requiredFields } of ENGINE_OPERATIONS) {
      assert.ok(declared.includes(`readonly ${JSON.stringify(id)}:`));
      for (const field of inputFields) assert.ok(declared.includes(`readonly ${JSON.stringify(field)}${requiredFields?.includes(field) ? '' : '?'}:`));
    }
    for (const helper of Object.keys(ENGINE_HELPERS)) assert.ok(declared.includes(`  ${helper}(`));
  });

});

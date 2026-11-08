/** Qualify the actual packed artifact in hosts which have no SFlow source checkout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildEngineSdk } from '../scripts/build-engine-sdk.mjs';
import { ENGINE_OPERATIONS, ENGINE_HELPERS } from '../src/engine-sdk/index.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@singularity-flow/engine-sdk';
const child = (executable, args, options) => {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000, ...options });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
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
          const reference=await text(JSON.stringify(packet));
          inputs={operationId:'approve-configuration',source:reference,expectedRevision:null,confirm:reference.sha256,reason:'Reviewed the complete workflow package.'};
          await writeFile('configuration-inputs.json',JSON.stringify(inputs));
        }else inputs=JSON.parse(await readFile('configuration-inputs.json','utf8'));
        const engine=createNamespaceConfigurationEngine({records,content,scope,authority,access,clock});
        const result=await engine.run('configuration.approve',inputs);
        const head=await records.read(scope,'config',NAMESPACE_CONFIGURATION_HEAD_KEY);
        assert.equal(result.replayed,!fresh);assert.equal(result.revision,head.record.version);assert.equal(result.effects.configurationApproved,true);
        const compiled=JSON.parse(Buffer.from((await content.read(scope,result.configuration)).data).toString('utf8'));
        assert.deepEqual(compiled.workTypeIds,['simple','routing']);assert.equal(compiled.definition.agentCatalog[0].id,'analyst');
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
          permissions:['phase.prepare','phase.draft.read','phase.draft.write','phase.draft.rebase']})};
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
        assert.equal(JSON.stringify(result).includes(path.resolve('private-records')),false);
        process.stdout.write(JSON.stringify(result));
      }finally{sharedDatabase.close();privateDatabase.close();}
    `;
    const first=JSON.parse(await run('preparation.mjs',source,['fresh']));
    const replay=JSON.parse(await run('preparation.mjs',source,['replay']));
    assert.deepEqual(replay,{...first,replayed:true});
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

  await t.test('installed declarations resolve with NodeNext and reject wrong operations, fields and types', async () => {
    const source = `
      import { createEngine, ENGINE_HELPERS, SingularityFlowError } from '${packageName}';
      import type { EngineInputs, EngineOperation, EngineResult } from '${packageName}';
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
      import { createNamespacePublicationEngine,NAMESPACE_PUBLICATION_PROFILE } from '${packageName}/hosts/namespace-publication';
      import { createNamespaceSubmissionEngine,NAMESPACE_SUBMISSION_PROFILE,NAMESPACE_SUBMISSION_DECISION_PROFILE } from '${packageName}/hosts/namespace-submission';
      import { createNamespaceApprovalEngine,NAMESPACE_APPROVAL_PROFILE,NAMESPACE_ROUTED_APPROVAL_PROFILE } from '${packageName}/hosts/namespace-approval';
      import { createFilesystemSourceUnit } from '${packageName}/sources/filesystem';
      import type { SourceUnit } from '${packageName}/source';
      import type { ContentStore, ContentReference } from '${packageName}/content';
      import { emptyNamespaceState, NAMESPACE_JOURNAL_PORT } from '${packageName}/storage/journal';
      import type { NamespaceStore, NamespaceTransaction } from '${packageName}/namespace';
      const engine=createEngine({ports:{publication:{load:async()=>{throw new Error('host');},retained:async()=>null,
        prepare:async()=>null,commit:async()=>null,finish:async()=>null}}});
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
        const published:Promise<EngineResult<'phase.publish'>>=createNamespacePublicationEngine(options).publishPhase({phaseId:'review'});
        // @ts-expect-error Shared publication still needs its explicit private authored-byte ports.
        createNamespacePublicationEngine({records,content,scope:options.scope,workId:options.workId,authority:options.authority,access:options.access,clock:options.clock});
        // @ts-expect-error Operation inputs cannot claim their own permission or supply an authenticated actor.
        createNamespacePublicationEngine(options).publishPhase({phaseId:'review',actor:{principalId:'administrator'}});
        return [profile,published];
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

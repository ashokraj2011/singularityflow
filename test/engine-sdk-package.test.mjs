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
      const blocked = [];
      const hooks = registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('node:')) { blocked.push(specifier); throw new Error('infrastructure import: ' + specifier); }
        return next(specifier, context);
      } });
      const sdk = await import('${packageName}');
      assert.equal(sdk.ENGINE_CONTRACT, 'sflow-engine/v1');
      let calls = 0;
      const original = Object.freeze(new Error('trusted host unavailable'));
      const engine = sdk.createEngine({ ports: { publication: Object.fromEntries(
        ['load','retained','prepare','commit','finish'].map(stage => [stage, async () => { calls++; throw original; }])) } });
      for (const helper of Object.keys(sdk.ENGINE_HELPERS)) assert.equal(engine[helper].name, helper);
      await assert.rejects(engine.run('phase.publish', {root:'/other'}), {code:'ENGINE_INPUT_INVALID'});
      assert.equal(calls, 0);
      await assert.rejects(engine.publishPhase({}), error => error === original);
      assert.equal(calls, 1);
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
      import {createNamespaceReadEngine,namespaceStoryReadKey,projectNamespaceReadState,namespaceReadRecord} from '${packageName}/hosts/namespace-reader';
      const directory=process.argv[2],create=process.argv[3]==='create';await mkdir(directory,{recursive:true});
      const db=new DatabaseSync(path.join(directory,'objects.db'));db.enableDefensive(true);db.enableLoadExtension(false);
      const scope={projectId:'headless-application'},workId='example',binding={kind:'shared'};
      const records=await createFilesystemNamespaceStore({root:path.join(directory,'records'),binding,create});
      const content=createSqliteContentStore({database:db,binding,create});
      try{
        if(create){
          const body=Buffer.from('Retained custom-phase output.\\n'),artifact=(await content.put(scope,'evidence',body)).reference;
          const sourceKey='singularity/work-items/example/artifacts/custom/summary.md';
          const workflow={workItem:{id:workId,branch:'team/branch'},currentPhase:'custom',phases:{custom:{id:'custom',generation:1,status:'in_progress',
            requiredArtifact:{path:'artifacts/custom/summary.md',kind:'custom-report'},artifacts:[{path:sourceKey,sha256:artifact.sha256,size:artifact.bytes}],agentBriefs:[]}}};
          const state=projectNamespaceReadState(workflow),policy=namespaceReadRecord('policy',{workItemRoot:'singularity/work-items',maximumPreviewBytes:1048576});
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
        await assert.rejects(engine.approvePhase({}),error=>error instanceof SingularityFlowError&&error.code==='ENGINE_PORT_UNAVAILABLE');
      }finally{db.close();}
    `;
    const data = path.join(directory, 'namespace-data');
    await run('reader.mjs', source, [data, 'create']); await run('reader.mjs', source, [data, 'resume']);
  });
  await t.test('installed declarations resolve with NodeNext and reject wrong operations, fields and types', async () => {
    const source = `
      import { createEngine, ENGINE_HELPERS, SingularityFlowError } from '${packageName}';
      import type { EngineInputs, EngineOperation, EngineResult } from '${packageName}';
      import { createFilesystemNamespaceStore } from '${packageName}/storage/filesystem';
      import { createSqliteNamespaceStore } from '${packageName}/storage/sqlite';
      import { createApplicationNamespaceStore } from '${packageName}/storage/application';
      import { createSqliteContentStore } from '${packageName}/storage/sqlite-content';
      import { createNamespaceReadEngine, namespaceReadRecord } from '${packageName}/hosts/namespace-reader';
      import type { ContentStore, ContentReference } from '${packageName}/content';
      import { emptyNamespaceState, NAMESPACE_JOURNAL_PORT } from '${packageName}/storage/journal';
      import type { NamespaceStore, NamespaceTransaction } from '${packageName}/namespace';
      const engine=createEngine({ports:{publication:{load:async()=>{throw new Error('host');},retained:async()=>null,
        prepare:async()=>null,commit:async()=>null,finish:async()=>null}}});
      const check:Promise<EngineResult<'phase.publish'>>=engine.publishPhase({workId:'example'});
      const operation:EngineOperation=ENGINE_HELPERS.publishPhase;
      const input:EngineInputs['phase.enter']={workId:'example',compose:true};
      engine.run('phase.enter',input);
      engine.run('workflow.assets',{workflowIds:['story:feature']});
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
      function readHost(records:NamespaceStore,content:ContentStore){return createNamespaceReadEngine({records,content,scope:{projectId:'example'},workId:'example'});}
      void [check,operation,tx,filesystem,database,unavailable,createApplicationNamespaceStore,emptyNamespaceState,NAMESPACE_JOURNAL_PORT];
      void [head,readHost,createSqliteContentStore];
    `;
    const file = path.join(consumer, 'types.mts'); await writeFile(file, source);
    const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: false, types: [],
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
    const declared = await readFile(path.join(consumer, 'node_modules', packageName, 'dist/index.d.mts'), 'utf8');
    for (const { id, inputFields } of ENGINE_OPERATIONS) {
      assert.ok(declared.includes(`readonly ${JSON.stringify(id)}:`));
      for (const field of inputFields) assert.ok(declared.includes(`readonly ${JSON.stringify(field)}?:`));
    }
    for (const helper of Object.keys(ENGINE_HELPERS)) assert.ok(declared.includes(`  ${helper}(`));
  });
});

/** Development-only source inventory. Parses entry points; never imports or executes a handler. */
import {createHash} from 'node:crypto';import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';import ts from 'typescript';
import {COMMAND_REGISTRY} from '../src/command-registry.mjs';
import {ENGINE_HELPERS,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {engineOperationInventory} from './engine-operation-inventory.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),extensions=new Set(['.mjs','.js','.cjs','.ts','.mts']),
  slash=value=>value.split(path.sep).join('/'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Reviewed responsibility of each current non-literal import site. This does not resolve or run it.
const dynamicOwners=Object.freeze({
  'src/ast-replay.mjs':'world-model',
  'src/cli-entry.mjs':'host-adapter',
  'src/configuration-branch.mjs':'native-storage-compatibility',
  'src/delivery-evidence.mjs':'native-evidence-compatibility',
  'src/engine-compatibility/approval-transition.mjs':'native-evidence-compatibility',
  'src/engine-compatibility/native-phase-entry.mjs':'native-evidence-compatibility',
  'src/engine-compatibility/submission-transition.mjs':'native-evidence-compatibility',
  'src/initialization/runtime-readiness.mjs':'host-adapter',
  'src/inject.mjs':'host-prompt-composition',
  'src/model-providers/copilot-cli.mjs':'sgos-provider-adapter',
  'src/phase-draft-check.mjs':'native-evidence-compatibility',
  'src/phase-prompt-composer.mjs':'host-prompt-composition',
  'src/skp-amendment-audit.mjs':'native-storage-compatibility',
  'src/state.mjs':'native-lifecycle-compatibility',
  'src/story-lineage.mjs':'native-evidence-compatibility',
  'src/test-runtime.mjs':'sgos-environment-adapter',
  'src/util.mjs':'source-control-adapter',
  'src/verification/witness-records.mjs':'native-evidence-compatibility',
  'src/workspace.mjs':'host-workspace-adapter',
  'src/worldmodel.mjs':'world-model'
});
function refused(message,code,details){throw Object.assign(Error(message),{code,details});}
function sourceFacts(text,file,operations,helpers){
  const parsed=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,false,ts.ScriptKind.TS),imports=[],dynamic=[],calls=[];
  if(parsed.parseDiagnostics.length)refused('A native entry source could not be parsed.','ENGINE_NATIVE_INVENTORY_SYNTAX',{
    path:file,diagnostics:parsed.parseDiagnostics.map(row=>({start:row.start,length:row.length,message:ts.flattenDiagnosticMessageText(row.messageText,' ')}))});
  const literal=node=>node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))?node.text:null;
  const line=node=>parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line+1;
  function visit(node){
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){
      const specifier=literal(node.moduleSpecifier);if(specifier!==null)imports.push({specifier,kind:ts.isImportDeclaration(node)?'import':'export',line:line(node)});
    }else if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'){
        const specifier=node.arguments.length===1?literal(node.arguments[0]):null;
        if(specifier!==null)imports.push({specifier,kind:node.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-literal':'require-literal',line:line(node)});
        else dynamic.push({line:line(node),kind:node.expression.kind===ts.SyntaxKind.ImportKeyword?'import-expression':'require-expression'});
      }
      if(ts.isPropertyAccessExpression(node.expression)){
        const name=node.expression.name.text,argument=literal(node.arguments[0]);
        if(name==='run'&&operations.has(argument))calls.push({operation:argument,kind:'operation-literal',line:line(node)});
        else if(Object.hasOwn(helpers,name))calls.push({operation:helpers[name],kind:'helper-name',line:line(node)});
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(parsed);return {imports,dynamicImports:dynamic,dispatchObservations:calls};
}
/** Limits are for a developer's source inventory, not runtime cache or authorization policies. */
export async function nativeEngineEntryInventory({rootDir=root,commands=COMMAND_REGISTRY,operationIds=ENGINE_OPERATIONS.map(row=>row.id),
  helpers=ENGINE_HELPERS,maximumModules=5000,maximumBytes=64*1024*1024,maximumFileBytes=4*1024*1024}={}){
  if(!Array.isArray(commands)||commands.length>1024||!Array.isArray(operationIds)||operationIds.some(value=>typeof value!=='string')
    ||[maximumModules,maximumBytes,maximumFileBytes].some(value=>!Number.isSafeInteger(value)||value<1))refused('Use a bounded explicit source inventory.','ENGINE_NATIVE_INVENTORY_INPUT');
  const physical=await realpath(rootDir),operations=new Set(operationIds),facts=new Map(),pending=new Set(),entryFiles=[];
  const relative=absolute=>{const local=path.relative(physical,absolute);if(!local||local==='..'||local.startsWith('..'+path.sep)||path.isAbsolute(local))
    refused('A native import escaped the selected checkout.','ENGINE_NATIVE_INVENTORY_PATH',{path:slash(local)});return slash(local);};
  const queued=file=>{relative(path.resolve(physical,file));if(!facts.has(file))pending.add(file);};
  async function discover(directory){for(const entry of (await readdir(path.join(physical,directory),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=directory+'/'+entry.name;if(entry.isSymbolicLink())refused('A native entry point is a symbolic link.','ENGINE_NATIVE_INVENTORY_PATH',{path:file});
    if(entry.isDirectory())await discover(file);else if(entry.isFile()&&extensions.has(path.extname(entry.name))){entryFiles.push(file);queued(file);}}}
  await discover('src/commands');
  const selected=commands.map(command=>{
    if(!command||typeof command.name!=='string'||typeof command.modulePath!=='string'||!command.modulePath.startsWith('./commands/'))
      refused('A command has no explicit native entry point.','ENGINE_NATIVE_INVENTORY_INPUT');
    const module=relative(path.resolve(physical,'src',command.modulePath));queued(module);
    return {name:command.name,aliases:[...(command.aliases??[])],classification:command.classification??null,module};
  });
  if(new Set(selected.map(row=>row.name)).size!==selected.length)refused('Native command names must be unique.','ENGINE_NATIVE_INVENTORY_INPUT');
  let total=0;
  while(pending.size){
    const file=pending.values().next().value;pending.delete(file);if(facts.has(file))continue;
    if(facts.size>=maximumModules)refused('Native source inventory exceeded its module bound.','ENGINE_NATIVE_INVENTORY_LIMIT',{maximumModules});
    const absolute=path.resolve(physical,file),info=await lstat(absolute);
    if(!info.isFile()||info.isSymbolicLink()||relative(await realpath(absolute))!==file)refused('A native source is not an exact regular checkout file.','ENGINE_NATIVE_INVENTORY_PATH',{path:file});
    if(info.size>maximumFileBytes||total+info.size>maximumBytes)refused('Native source inventory exceeded its byte bound.','ENGINE_NATIVE_INVENTORY_LIMIT',{path:file,maximumBytes,maximumFileBytes});
    const bytes=await readFile(absolute);if(bytes.byteLength>maximumFileBytes||total+bytes.byteLength>maximumBytes)refused('Native source grew beyond the byte bound.','ENGINE_NATIVE_INVENTORY_LIMIT',{path:file});
    total+=bytes.byteLength;let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(cause){throw Object.assign(Error('Native source must be UTF-8.'),{code:'ENGINE_NATIVE_INVENTORY_SYNTAX',cause,path:file});}
    const parsed=sourceFacts(text,file,operations,helpers),local=[],resources=[],external=[];
    for(const row of parsed.imports){if(!row.specifier.startsWith('.')){external.push(row);continue;}
      const target=relative(path.resolve(path.dirname(absolute),row.specifier));
      if(extensions.has(path.extname(target))){local.push({...row,path:target});queued(target);}else resources.push({...row,path:target});}
    facts.set(file,{path:file,sha256:hash(bytes),bytes:bytes.byteLength,entryPoint:entryFiles.includes(file),
      imports:local,externalImports:external,resourceImports:resources,dynamicImports:parsed.dynamicImports.map(row=>({...row,owner:dynamicOwners[file]??null})),dispatchObservations:parsed.dispatchObservations});
  }
  const modules=[...facts.values()].sort((a,b)=>a.path.localeCompare(b.path));
  function closure(file){const found=new Set(),queue=[file];while(queue.length){const next=queue.pop();if(found.has(next))continue;found.add(next);
      const value=facts.get(next);if(!value)refused('The native source graph lost a module.','ENGINE_NATIVE_INVENTORY_CORRUPT',{path:next});queue.push(...value.imports.map(row=>row.path));}
    return [...found].sort();}
  for(const command of selected){const reachable=closure(command.module),rows=reachable.map(file=>facts.get(file)),
      sources=prefix=>reachable.filter(file=>file.startsWith(prefix));
    command.reachableModules=reachable.length;command.reachableBytes=rows.reduce((sum,row)=>sum+row.bytes,0);
    command.legacyDispatcher=reachable.includes('src/cli.mjs');
    command.compatibilityOwners=sources('src/engine-compatibility/');command.kernelOwners=sources('src/kernel/');
    command.sdaOwners=sources('src/sda/');command.sgosOwners=sources('src/sgos/');
    command.nativePersistenceOwners=reachable.filter(file=>/^src\/(?:state|state-stores|git|ledger)\.mjs$/u.test(file));
    command.unresolvedDynamicImports=rows.flatMap(row=>row.dynamicImports.map(observation=>({path:row.path,...observation})));
    command.observedOperations=[...new Set(rows.flatMap(row=>row.dispatchObservations.map(observation=>observation.operation)))].sort();
  }
  return {schemaVersion:1,profile:'sflow-native-engine-entry-inventory/v1',
    method:'bounded-static-syntax',commands:selected,modules,entryPoints:[...entryFiles].sort(),
    totals:{commands:selected.length,entryPoints:entryFiles.length,modules:modules.length,sourceBytes:total,
      legacyCommands:selected.filter(row=>row.legacyDispatcher).length,dynamicImportSites:modules.reduce((sum,row)=>sum+row.dynamicImports.length,0)},
    unclassifiedDynamicImports:modules.flatMap(row=>row.dynamicImports.filter(site=>site.owner===null).map(site=>({path:row.path,...site}))),
    qualificationExecuted:false,callGraphProved:false,authorityGranted:false,readinessEstablished:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).some(value=>value!=='--json'))refused('Use --json or no arguments.','ENGINE_NATIVE_INVENTORY_INPUT');
  const native=await nativeEngineEntryInventory(),registered=engineOperationInventory();
  const report={...native,registered:registered.totals,remainingNamespaceOperations:registered.operations.filter(row=>!row.namespaceBound)
    .map(({id,port,optionalCapability})=>({id,port,...(optionalCapability?{optionalCapability}:{})}))};
  process.stdout.write(JSON.stringify(process.argv.includes('--json')?report:{schemaVersion:report.schemaVersion,profile:report.profile,
    method:report.method,totals:report.totals,registered:report.registered,remainingNamespaceOperations:report.remainingNamespaceOperations,
    unclassifiedDynamicImports:report.unclassifiedDynamicImports,
    qualificationExecuted:false,callGraphProved:false,authorityGranted:false,readinessEstablished:false},null,process.argv.includes('--json')?undefined:2)+'\n');
}

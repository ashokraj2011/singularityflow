/** Source-bound dependency closure. An impact map is knowledge, never execution or human consent. */
import {canonicalJson,textDigestCapability,testImpactObservationProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
const fail=(message,code='TEST_IMPACT_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const path=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.startsWith('-')&&!/[\\:*?\[\]{}\0]/u.test(value)
  &&!value.startsWith('/')&&!value.split('/').some(part=>['','.','..'].includes(part));
const key=row=>canonicalJson([row.repositoryId,row.path]);
const sorted=values=>[...new Set(values)].sort();
function object(value,fields){if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('Impact records must be plain bounded data.','ENGINE_PORT_RESULT_INVALID');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(keys.length!==fields.length||keys.some(key=>typeof key!=='string'||!fields.includes(key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))
    fail('Impact records cannot contain source bodies, unknown fields or accessors.','ENGINE_PORT_RESULT_INVALID');}
export function namespaceTestImpactPolicies(port){
  const hash=value=>'sha256:'+textDigestCapability(port).sha256Utf8(canonicalJson(value));
  function graph(value,sources){
    object(value,['schemaVersion','profile','analyzer','sources','nodes','unknown']);object(value.analyzer,['id','version','implementationSha256']);
    const profile=testImpactObservationProfile(value);
    if(!value||value.profile!==profile.profile
      ||typeof value.analyzer?.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.analyzer.id)||typeof value.analyzer?.version!=='string'||!value.analyzer.version||value.analyzer.version.length>128
      ||!/^sha256:[a-f0-9]{64}$/u.test(value.analyzer?.implementationSha256??'')
      ||!Array.isArray(value.sources)||!Array.isArray(value.nodes)||value.nodes.length>100000||!Array.isArray(value.unknown)||value.unknown.length>100000)
      fail('Use an explicit bounded impact observation from the bound analyzer.','ENGINE_PORT_RESULT_INVALID');
    for(const row of value.sources)object(row,['repositoryId','revision']);
    const wanted=sources.map(row=>({repositoryId:row.repositoryId,revision:row.revision}));
    if(canonicalJson(value.sources)!==canonicalJson(wanted))fail('Impact observation belongs to different source bytes.','TEST_IMPACT_SOURCE_CHANGED');
    const members=new Map(sources.flatMap(source=>source.snapshot.entries.map(entry=>[key({repositoryId:source.repositoryId,path:entry.path}),entry]))),seen=new Set();let edges=0;
    for(const node of value.nodes){object(node,['repositoryId','path','sha256','dependencies']);const id=key(node),member=members.get(id);
      if(!path(node.path)||!member||node.sha256!==member.sha256||seen.has(id)||!Array.isArray(node.dependencies)||node.dependencies.length>10000)
        fail('Impact nodes need unique members of the exact source observation.','ENGINE_PORT_RESULT_INVALID');
      seen.add(id);const targets=new Set();for(const target of node.dependencies){object(target,['repositoryId','path']);const targetId=key(target);
        if(!path(target.path)||!members.has(targetId)||targets.has(targetId)||++edges>1000000)fail('Impact edges need unique selected source members.','ENGINE_PORT_RESULT_INVALID');targets.add(targetId);}
    }
    for(const item of value.unknown){object(item,['repositoryId','path','reason']);if(!path(item.path)||!members.has(key(item))||typeof item.reason!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/u.test(item.reason))
      fail('Unknown impact scope needs a bounded real source member and reason code.','ENGINE_PORT_RESULT_INVALID');}
    return structuredClone(value);
  }
  function select({before,current,observation,commands,requiredFiles=[]}){
    const value=graph(observation,current),nodes=new Map(value.nodes.map(row=>[key(row),row])),
      old=new Map(before.flatMap(source=>source.snapshot.entries.map(row=>[key({repositoryId:source.repositoryId,path:row.path}),row]))),
      now=new Map(current.flatMap(source=>source.snapshot.entries.map(row=>[key({repositoryId:source.repositoryId,path:row.path}),row]))),changed=[];
    for(const id of new Set([...old.keys(),...now.keys()]))if(canonicalJson(old.get(id)??null)!==canonicalJson(now.get(id)??null))changed.push(id);
    const reverse=new Map();for(const node of nodes.values())for(const target of node.dependencies){const id=key(target);if(!reverse.has(id))reverse.set(id,[]);reverse.get(id).push(key(node));}
    const affected=new Set(changed),queue=[...changed];for(let i=0;i<queue.length;i++)for(const id of reverse.get(queue[i])??[])if(!affected.has(id)){affected.add(id);queue.push(id);}
    const protectedChange=changed.some(id=>/(?:^|\/)(?:tests?|__tests__|fixtures?|config|configuration|node_modules|vendor|build|dist)(?:\/|$)|(?:^|[._-])(?:test|spec|config|lock)(?:[._-]|$)|(?:^|\/)(?:package|pom|requirements|pyproject)(?:[.-]|$)/iu.test(JSON.parse(id)[1]));
    const reasons=[...(value.unknown.length?['analyzer-unresolved-inputs']:[]),...(protectedChange?['protected-test-runner-or-dependency-change']:[]),...(nodes.size!==now.size?['incomplete-source-graph']:[]),
      ...(changed.some(id=>!nodes.has(id))?['added-removed-or-unmapped-source']:[])],fallback=reasons.length>0;
    const rows=commands.map(row=>{
      const files=sorted(row.files),required=requiredFiles.filter(file=>file.repositoryId===row.repositoryId).map(file=>file.path),
        selected=fallback?files:files.filter(file=>affected.has(key({repositoryId:row.repositoryId,path:file}))||required.includes(file));
      // An empty selector must never turn a configured command into a successful non-execution.
      return {repositoryId:row.repositoryId,commandId:row.commandId,files:selected.length?selected:files,
        expanded:fallback||!selected.length,reasons:fallback?reasons:!selected.length?['empty-impact-expands-command']:['changed-or-transitively-affected','planned-and-changed-tests']};
    });
    return {profile:'sflow-test-impact-selection/v1',observationSha256:hash(value),changed:changed.sort().map(id=>{const [repositoryId,path]=JSON.parse(id);return {repositoryId,path};}),
      rows,dependencyCoverage:fallback?'expanded-configured-commands':'closed-static-graph',impactComplete:false,failuresWaived:false};
  }
  return Object.freeze({hash,graph,select});
}

/** A pinned repository runner may forward whole files after --; no arbitrary argv or case filters. */
export function namespaceScriptTestInventory(port){
  const hash=value=>'sha256:'+textDigestCapability(port).sha256Utf8(canonicalJson(value));
  function narrow(command,declaration,files,{requiredFiles=[]}={}){
    if(declaration?.adapter!=='node-script-junit-v1'||declaration.dependencyScope!=='repository-and-node-builtins-only'
      ||command.kind!=='test'||command.argv?.[0]!=='node'||!path(command.argv[1])||!/^.+\.[cm]?js$/u.test(command.argv[1])||command.argv[2]!=='--test-reporter=junit'||command.argv[3]!=='--'
      ||command.result?.adapter!=='junit-xml'||Object.keys(command.env??{}).length||!declaration.tests?.length)
      fail('Bind an independently inventoried pinned Node script with literal file forwarding after --.','SELECTIVE_TEST_RECOVERY_UNSUPPORTED');
    if(!Array.isArray(files)||!files.length||new Set(files).size!==files.length||files.some(file=>!path(file))
      ||!['minimumPassed','minimumDiscovered'].every(key=>Number.isSafeInteger(command.result[key])&&command.result[key]>=1))fail('Use a nonempty literal file selection and positive independent test minima.');
    const full=command.argv.slice(4),expected=declaration.tests;
    if(full.some(file=>!path(file))||new Set(full).size!==full.length||full.length>256||files.some(file=>!full.includes(file))
      ||full.some(file=>!expected.some(row=>row.path===file))||expected.some(row=>!full.includes(row.path))||new Set(expected.map(row=>row.id)).size!==expected.length)
      fail('The script selector differs from the independent full file inventory.');
    if(requiredFiles.some(file=>full.includes(file)&&!files.includes(file)))fail('Planned and changed tests must execute.','SELECTIVE_TEST_REQUIRED_FILE_EXCLUDED',{paths:requiredFiles.filter(file=>full.includes(file)&&!files.includes(file))});
    const selectedIds=expected.filter(row=>files.includes(row.path)).map(row=>row.id);
    return {repositoryMode:'reviewed-file-selection',argv:[...command.argv.slice(0,4),...files],files:[...files],selectedIds,
      excludedIds:expected.filter(row=>!files.includes(row.path)).map(row=>row.id),inventoryIds:expected.map(row=>row.id),
      effectiveMinimums:{minimumDiscovered:Math.min(command.result.minimumDiscovered,selectedIds.length),minimumPassed:Math.min(command.result.minimumPassed,selectedIds.length)},impactComplete:false,failuresWaived:false};
  }
  function observed({command,declaration,snapshot,parsed,reportSha256s}){
    narrow(command,declaration,[...new Set(declaration.tests.map(row=>row.path))]);
    const ids=new Set();if(parsed.cases.length!==declaration.tests.length||parsed.tests.discovered!==declaration.tests.length||parsed.tests.skipped)
      fail('The actual script report must execute the entire independent case inventory.','SELECTIVE_TEST_REPORT_INVALID');
    for(const row of parsed.cases){const test=declaration.tests.find(test=>test.path===row.file&&test.name===row.name);
      if(!test||ids.has(test.id)||!['passed','failed'].includes(row.outcome))fail('The script report has an ambiguous or unsupported case.','SELECTIVE_TEST_REPORT_INVALID');ids.add(test.id);}
    const stable=snapshot.entries.filter(row=>!declaration.baselineMutableRoots?.some(root=>row.path.startsWith(root+'/'))
      ||/test|spec|fixture|config|package|lock/iu.test(row.path)||row.path===command.argv[1]);
    return {counts:parsed.tests,reportSha256s,dependencies:[{id:'baseline-compatibility',sha256:hash({stable,declaration,command})}]};
  }
  return Object.freeze({narrow,observed});
}

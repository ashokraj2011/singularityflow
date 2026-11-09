/** Portable source-snapshot comparison and read-operation contracts. No repository or file access. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot,sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {phaseAccessIdentity} from './phase-preparation.mjs';
import {projectEnrollmentTimestamp} from './project-enrollment.mjs';

const fail=(message,code='ENGINE_INPUT_INVALID')=>{throw new SingularityFlowError(message,{code});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,fields)=>plain(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const revision=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u0020\u007f]/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;

export function phaseSourceInspectionInput(input) {
  if(!plain(input)||Object.keys(input).some(key=>!['workId','phaseId','maximumEntries'].includes(key))
    ||['workId','phaseId'].some(key=>input[key]!==undefined&&!id(input[key]))
    ||input.maximumEntries!==undefined&&(!count(input.maximumEntries)||input.maximumEntries>1024)) {
    fail('Source inspection needs a valid Story, phase and bounded entry budget.');
  }
  return {...input,maximumEntries:input.maximumEntries??200};
}
export function phaseSourceRetentionInput(input) {
  if(!exact(input,['operationId','workId','phaseId'])||Object.values(input).some(value=>!id(value)))fail('Source retention needs an exact operation ID, Story and phase.');
  return {...input};
}
export function phaseSourceRetentionResult(input,facts) {
  const bad=()=>fail('The source-retention owner returned another or incomplete evidence binding.','ENGINE_PORT_RESULT_INVALID');
  if(!exact(facts,['workId','phase','operationId','generation','record','recordedAt','principalId','replayed','repositories','totals'])
    ||facts.workId!==input.workId||facts.phase!==input.phaseId||facts.operationId!==input.operationId||!count(facts.generation)||facts.generation<1
    ||typeof facts.replayed!=='boolean'||typeof facts.principalId!=='string'||!facts.principalId||typeof facts.recordedAt!=='string'||!Number.isFinite(Date.parse(facts.recordedAt))
    ||!exact(facts.record,['key','version','content'])||!/^source-retention\/results\/[a-f0-9]{64}$/u.test(facts.record.key??'')||!revision(facts.record.version)
    ||!exact(facts.record.content,['namespace','sha256','bytes'])||facts.record.content.namespace!=='evidence'||!sha(facts.record.content.sha256)||!count(facts.record.content.bytes)
    ||!Array.isArray(facts.repositories)||!facts.repositories.length||facts.repositories.length>32
    ||!exact(facts.totals,['added','modified','removed','files','bytes','chunks','protectedChanges','boundaryViolations'])||Object.values(facts.totals).some(value=>!count(value))
    ||facts.totals.files!==facts.totals.added+facts.totals.modified||facts.totals.protectedChanges>facts.totals.files+facts.totals.removed
    ||facts.totals.boundaryViolations>facts.totals.files+facts.totals.removed)bad();
  const seen=new Set();
  for(const repository of facts.repositories){
    if(!exact(repository,['id','manifest'])||!id(repository.id)||seen.has(repository.id)||!exact(repository.manifest,['namespace','sha256','bytes'])
      ||repository.manifest.namespace!=='evidence'||!sha(repository.manifest.sha256)||!count(repository.manifest.bytes))bad();seen.add(repository.id);
  }
  return {status:facts.replayed?'retained':'recorded',subject:{kind:'story',id:input.workId},phase:input.phaseId,...facts,
    scope:'changed-application-paths',sourceContentsRetained:true,baselineContentsRetained:false,publicationReadinessInspected:false,
    effects:{committed:!facts.replayed,pushed:false,evidenceRecorded:!facts.replayed,sourceFilesChanged:false,canonicalStateChanged:false,
      phasePublished:false,testsRun:false,approvalRecorded:false,storyAdvanced:false}};
}

/** Exact path additions/removals, content and executable-mode changes; never inferred Git renames. */
export function sourceSnapshotChanges(before,after,descriptor) {
  sourceSnapshot(before,descriptor);sourceSnapshot(after,descriptor);
  const entries=[],totals={added:0,modified:0,removed:0,changes:0};
  const facts=entry=>entry?{sha256:entry.sha256,bytes:entry.bytes,executable:entry.executable}:null;
  let left=0,right=0;
  while(left<before.entries.length||right<after.entries.length) {
    const old=before.entries[left]??null,current=after.entries[right]??null;
    let previous=null,next=null;
    if(current===null||old!==null&&old.path<current.path){previous=old;left++;}
    else if(old===null||current.path<old.path){next=current;right++;}
    else {previous=old;next=current;left++;right++;
      if(old.sha256===current.sha256&&old.bytes===current.bytes&&old.executable===current.executable)continue;}
    const status=previous===null?'A':next===null?'D':'M';
    totals[status==='A'?'added':status==='D'?'removed':'modified']++;totals.changes++;
    entries.push({changeId:`source-${entries.length+1}`,status,oldPath:previous?.path??null,newPath:next?.path??null,
      before:facts(previous),after:facts(next)});
  }
  return {schemaVersion:1,format:'sflow-source-snapshot-changes/v1',repositoryId:descriptor.repositoryId,
    renameDetection:'not-observed',tracking:'not-observed',totals,entries};
}

/** Small bounded presentation only; source readiness and human authority are separate operations. */
export function phaseSourceInspectionManifest(workId,phaseId,facts,maximumEntries) {
  const bad=()=>fail('The source reader returned another or unbounded inspection binding.','ENGINE_PORT_RESULT_INVALID');
  if(!exact(facts,['workId','phase','status','revision','authorityVersion','configuration','draft','sourceBinding','repositories','totals','recovery'])
    ||facts.workId!==workId||facts.phase!==phaseId||!['missing-draft','stale-draft','not-code-generation','inspected'].includes(facts.status)
    ||!revision(facts.revision)||!revision(facts.authorityVersion)||!exact(facts.configuration,['key','content'])
    ||typeof facts.configuration.key!=='string'||!exact(facts.configuration.content,['namespace','sha256','bytes'])
    ||facts.configuration.content.namespace!=='config'||!sha(facts.configuration.content.sha256)||!count(facts.configuration.content.bytes)
    ||!Array.isArray(facts.repositories)||facts.repositories.length>32
    ||!exact(facts.totals,['added','modified','removed','changes','shown','truncated'])
    ||['added','modified','removed','changes','shown'].some(key=>!count(facts.totals[key]))
    ||facts.totals.changes!==facts.totals.added+facts.totals.modified+facts.totals.removed
    ||facts.totals.shown>maximumEntries||typeof facts.totals.truncated!=='boolean'
    ||facts.totals.truncated!==(facts.totals.shown<facts.totals.changes))bad();
  const d=facts.draft;
  if(d!==null&&(!exact(d,['generation','revision','bodySha256','baseRevision'])||!count(d.generation)||d.generation<1
    ||!revision(d.revision)||!sha(d.bodySha256)||!revision(d.baseRevision)))bad();
  if(facts.status==='missing-draft'?d!==null:d===null)bad();
  if(facts.status==='stale-draft'?d.baseRevision===facts.revision:d!==null&&d.baseRevision!==facts.revision)bad();
  if(facts.status!=='inspected') {
    if(facts.repositories.length||facts.totals.changes||facts.sourceBinding!==null)bad();
  }else{
    if(!exact(facts.sourceBinding,['operationId','generationIntent'])||!id(facts.sourceBinding.operationId)
      ||!revision(facts.sourceBinding.generationIntent)||!facts.repositories.length||facts.recovery!==null)bad();
  }
  if(facts.status==='missing-draft'&&!exact(facts.recovery,['operation','inputs'])
    ||facts.status==='missing-draft'&&facts.recovery.operation!=='phase.prepare'
    ||facts.status==='stale-draft'&&(!exact(facts.recovery,['operation','inputs','requires'])||facts.recovery.operation!=='phase.draft.rebase')
    ||facts.status==='not-code-generation'&&facts.recovery!==null)bad();
  const summed={added:0,modified:0,removed:0,changes:0,shown:0},ids=new Set();
  for(const repo of facts.repositories){
    if(!exact(repo,['id','unitId','baselineRevision','observedRevision','changesSha256','policy','totals','roles','protectedChanges','boundaryViolations','entries'])
      ||!id(repo.id)||ids.has(repo.id)||!id(repo.unitId)||!/^sha256:[a-f0-9]{64}$/u.test(repo.baselineRevision??'')
      ||!/^sha256:[a-f0-9]{64}$/u.test(repo.observedRevision??'')||!sha(repo.changesSha256)
      ||!exact(repo.policy,['sourceBoundary','classificationComparison','protectedComparison','tracking','renameDetection'])
      ||!['unrestricted','test-automation'].includes(repo.policy.sourceBoundary)
      ||!['case-sensitive-portable','pinned-case-insensitive'].includes(repo.policy.classificationComparison)||repo.policy.protectedComparison!=='portable-case-insensitive'
      ||repo.policy.tracking!=='not-observed'||repo.policy.renameDetection!=='not-observed'
      ||!exact(repo.totals,['added','modified','removed','changes'])||Object.values(repo.totals).some(value=>!count(value))
      ||repo.totals.changes!==repo.totals.added+repo.totals.modified+repo.totals.removed
      ||!plain(repo.roles)||Object.values(repo.roles).some(value=>!count(value))
      ||Object.values(repo.roles).reduce((sum,value)=>sum+value,0)!==repo.totals.changes
      ||!count(repo.protectedChanges)||repo.protectedChanges>repo.totals.changes
      ||!count(repo.boundaryViolations)||repo.boundaryViolations>repo.totals.changes
      ||!Array.isArray(repo.entries)||repo.entries.length>repo.totals.changes)bad();
    ids.add(repo.id);
    for(const key of ['added','modified','removed','changes'])summed[key]+=repo.totals[key];
    summed.shown+=repo.entries.length;
    const changes=new Set();
    for(const entry of repo.entries){
      if(!exact(entry,['changeId','status','oldPath','newPath','before','after','role','protected','sourceBoundaryAllowed'])
        ||!id(entry.changeId)||changes.has(entry.changeId)||!['A','D','M'].includes(entry.status)||typeof entry.role!=='string'
        ||typeof entry.protected!=='boolean'||typeof entry.sourceBoundaryAllowed!=='boolean')bad();
      changes.add(entry.changeId);
      for(const [key,ref]of [['oldPath','before'],['newPath','after']]){
        if(entry[key]===null?entry[ref]!==null:typeof entry[key]!=='string'||!exact(entry[ref],['sha256','bytes','executable'])
          ||!sha(entry[ref].sha256)||!count(entry[ref].bytes)||typeof entry[ref].executable!=='boolean')bad();
        if(entry[key]!==null){try{sourceRelativePath(entry[key]);}catch{bad();}}
      }
      if(entry.status==='A'?(entry.oldPath!==null||entry.newPath===null):entry.status==='D'?(entry.newPath!==null||entry.oldPath===null)
        :entry.oldPath===null||entry.oldPath!==entry.newPath)bad();
    }
  }
  if(Object.keys(summed).some(key=>summed[key]!==facts.totals[key]))bad();
  return {schemaVersion:1,contract:'sflow-phase-source-inspection/v1',...facts,
    inference:'snapshot-and-path-policy',sourceContentsRetained:false,publicationReadinessInspected:false,
    finalBindingChecked:true,testsRun:false,approvalRecorded:false,humanReviewRecorded:false};
}

/** Existing source baseline retention and authenticated evidence-only access. */
export function sourceBaselineRetentionInput(input) {
  if(!exact(input,['operationId','workId','sourceBindingId'])||Object.values(input).some(v=>!id(v)))fail('Baseline retention needs an exact operation, Story and accepted source-binding ID.');
  return {...input};
}
export function sourceBaselineRetentionAccess(facts,projectId,{expected=null,authorize=true}={}) {
  const {actor}=phaseAccessIdentity(facts,projectId);
  if(authorize&&!facts.permissions.includes('source.baseline.retain'))fail('The current principal cannot archive this source baseline.','ENGINE_AUTHORITY_REQUIRED');
  if(expected!==null&&canonicalJson(actor)!==canonicalJson(expected))fail('Resume baseline retention under its original authenticated person.','ENGINE_ACTOR_CHANGED');
  return actor;
}
export function sourceBaselineRetentionResult(input,facts) {
  const bad=()=>fail('The baseline owner returned another or incomplete archive binding.','ENGINE_PORT_RESULT_INVALID');
  if(!exact(facts,['workId','operationId','sourceBindingId','record','recordedAt','principalId','replayed','repositories','totals'])
    ||facts.workId!==input.workId||facts.operationId!==input.operationId||facts.sourceBindingId!==input.sourceBindingId
    ||typeof facts.replayed!=='boolean'||!revision(facts.principalId)||!exact(facts.record,['key','version','content'])
    ||!/^source-baseline\/results\/[a-f0-9]{64}$/u.test(facts.record.key??'')||!revision(facts.record.version)
    ||!exact(facts.record.content,['namespace','sha256','bytes'])||facts.record.content.namespace!=='evidence'||!sha(facts.record.content.sha256)||!count(facts.record.content.bytes)
    ||!exact(facts.totals,['files','bytes','chunks'])||Object.values(facts.totals).some(value=>!count(value))
    ||!Array.isArray(facts.repositories)||facts.repositories.length<1||facts.repositories.length>32)bad();
  projectEnrollmentTimestamp(facts.recordedAt);const seen=new Set();
  for(const repository of facts.repositories){if(!exact(repository,['id','manifest'])||!id(repository.id)||seen.has(repository.id)
    ||!exact(repository.manifest,['namespace','sha256','bytes'])||repository.manifest.namespace!=='evidence'||!sha(repository.manifest.sha256)||!count(repository.manifest.bytes))bad();seen.add(repository.id);}
  return {status:facts.replayed?'retained':'recorded',subject:{kind:'story',id:input.workId},...facts,
    scope:'baseline-application-paths',baselineContentsRetained:true,publicationReadinessInspected:false,
    effects:{committed:!facts.replayed,pushed:false,evidenceRecorded:!facts.replayed,sourceFilesChanged:false,canonicalStateChanged:false,
      phasePublished:false,testsRun:false,approvalRecorded:false,storyAdvanced:false}};
}

/** Bounded observed source/test evidence. No publication, requirement or acceptance verdict. */
export function phaseDeliveryInspectionManifest(workId,phaseId,facts,maximumEntries) {
  const bad=()=>fail('The delivery inspector returned another or unbounded evidence binding.','ENGINE_PORT_RESULT_INVALID');
  if(!exact(facts,['workId','phase','status','revision','authorityVersion','configuration','draft','sourceBinding','evidence','repositories','tests','requiredPolicyOwners'])
    ||facts.workId!==workId||facts.phase!==phaseId||!['missing-draft','stale-draft','not-code-generation','observed'].includes(facts.status)
    ||!revision(facts.revision)||!revision(facts.authorityVersion)||!exact(facts.configuration,['key','content'])
    ||typeof facts.configuration.key!=='string'||!exact(facts.configuration.content,['namespace','sha256','bytes'])
    ||facts.configuration.content.namespace!=='config'||!sha(facts.configuration.content.sha256)||!count(facts.configuration.content.bytes)
    ||!exact(facts.evidence,['baseline','changes','checks'])||!Array.isArray(facts.repositories)||facts.repositories.length>32
    ||!Array.isArray(facts.requiredPolicyOwners)||facts.requiredPolicyOwners.length>128||facts.requiredPolicyOwners.some(value=>!id(value)))bad();
  const d=facts.draft;
  if(d!==null&&(!exact(d,['generation','revision','bodySha256','baseRevision'])||!count(d.generation)||d.generation<1||!revision(d.revision)||!revision(d.baseRevision)||!sha(d.bodySha256)))bad();
  if(facts.status==='missing-draft'?d!==null:d===null)bad();
  if(facts.status==='stale-draft'?d.baseRevision===facts.revision:d!==null&&d.baseRevision!==facts.revision)bad();
  for(const [kind,proof]of Object.entries(facts.evidence))if(proof!==null){
    if(!exact(proof,['operationId','record','index'])||!id(proof.operationId)||!exact(proof.record,['key','version','content'])
      ||typeof proof.record.key!=='string'||!revision(proof.record.version)||!exact(proof.record.content,['namespace','sha256','bytes'])
      ||proof.record.content.namespace!=='evidence'||!sha(proof.record.content.sha256)||!count(proof.record.content.bytes)
      ||!exact(proof.index,['key','version'])||typeof proof.index.key!=='string'||!revision(proof.index.version))bad();
    const prefix=kind==='baseline'?'source-baseline':kind==='changes'?'source-retention':'phase-checks';
    if(!proof.record.key.startsWith(prefix+'/')||!proof.index.key.startsWith(prefix+'/'))bad();
  }
  const seen=new Set();let displayed=0;
  for(const repository of facts.repositories){
    if(!exact(repository,['id','baselineRevision','currentRevision','retainedRevision','sourceMatched','checksMatched','safety','coverage'])
      ||!id(repository.id)||seen.has(repository.id)||!/^sha256:[a-f0-9]{64}$/u.test(repository.baselineRevision)||!/^sha256:[a-f0-9]{64}$/u.test(repository.currentRevision)
      ||repository.retainedRevision!==null&&!/^sha256:[a-f0-9]{64}$/u.test(repository.retainedRevision)
      ||['sourceMatched','checksMatched'].some(key=>repository[key]!==null&&typeof repository[key]!=='boolean')
      ||!exact(repository.safety,['protectedChanges','boundaryViolations'])||Object.values(repository.safety).some(value=>!count(value)))bad();seen.add(repository.id);
    const c=repository.coverage;
    if(!exact(c,['required','affectedPaths','uncoveredPaths','changedExecutableTests','pathCount','paths','truncated'])||typeof c.required!=='boolean'
      ||['affectedPaths','uncoveredPaths','changedExecutableTests','pathCount'].some(key=>!count(c[key]))||c.uncoveredPaths>c.affectedPaths
      ||!Array.isArray(c.paths)||c.paths.length>c.pathCount||c.pathCount<Math.max(c.affectedPaths,c.changedExecutableTests)
      ||c.pathCount>c.affectedPaths+c.changedExecutableTests||c.truncated!==(c.paths.length<c.pathCount)
      ||(repository.retainedRevision===null)!==(repository.sourceMatched===null)
      ||(facts.evidence.changes===null)!==(repository.sourceMatched===null)||(facts.evidence.checks===null)!==(repository.checksMatched===null))bad();
    const paths=new Set();for(const row of c.paths){if(!exact(row,['path','role','covered'])||!['source','configuration','test'].includes(row.role)
      ||row.covered!==null&&typeof row.covered!=='boolean')bad();sourceRelativePath(row.path);if(paths.has(row.path))bad();paths.add(row.path);}
    displayed+=c.paths.length;
  }
  if(displayed>maximumEntries||!exact(facts.tests,['status','checks'])||!['not-configured','missing','passed','failed','unavailable','partial','invalid'].includes(facts.tests.status)
    ||!Array.isArray(facts.tests.checks)||facts.tests.checks.length>1024)bad();
  for(const check of facts.tests.checks){if(!exact(check,['id','repositoryId','status','tests'])||!id(check.id)||!id(check.repositoryId)
    ||!['passed','failed','unavailable'].includes(check.status)||check.tests!==null&&(!plain(check.tests)||Object.values(check.tests).some(value=>!count(value))))bad();}
  const actions=[];const action=(operation,inputs,required=[],prerequisites=[])=>actions.push({operation,inputs,required,prerequisites});
  if(facts.status==='missing-draft')action('phase.prepare',{workId,phaseId});
  if(facts.status==='stale-draft'){if(!d)bad();action('phase.draft.rebase',{workId,phaseId,expectedRevision:d.revision,confirm:d.bodySha256},['operationId','reason']);}
  if(facts.status==='observed'){
    if(!d||!exact(facts.sourceBinding,['operationId'])||!id(facts.sourceBinding.operationId)||!facts.repositories.length)bad();
    if(!facts.evidence.baseline)action('source.baseline.retain',{workId,sourceBindingId:facts.sourceBinding.operationId},['operationId'],['original-source-selection-available']);
    if(!facts.evidence.changes||facts.repositories.some(row=>row.sourceMatched===false))action('phase.source.retain',{workId,phaseId},['operationId']);
    if(facts.tests.status!=='not-configured'&&(facts.tests.status!=='passed'||facts.repositories.some(row=>row.checksMatched===false)))action('phase.checks.run',{workId,phaseId},['operationId'],
      ['failed','unavailable','partial','invalid'].includes(facts.tests.status)?['repair-observed-check-failures']:[]);
  }else if(facts.sourceBinding!==null||facts.repositories.length||Object.values(facts.evidence).some(Boolean))bad();
  return {schemaVersion:1,contract:'sflow-delivery-evidence-inspection/v1',...facts,actions,
    observationsOnly:true,publicationReadinessInspected:false,applicationAcceptanceEstablished:false};
}

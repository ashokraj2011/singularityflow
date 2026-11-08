/** Read projections have their own frozen meaning. They are not lifecycle or approval authority. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_READER_SCHEMAS,namespaceReaderRecordProfile } from '../foundation/record-schema.mjs';
import { contentReference } from '../sda/content/contract.mjs';
import { exactObject, namespaceScope } from '../sda/namespace/values.mjs';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/u.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const bad = message => { throw new SingularityFlowError(message, { code: 'ENGINE_STORAGE_CORRUPT' }); };
const nullableText = value => value === null || text(value);
function validateBrief(value) {
  exactObject(value, ['generation','renderedPath','renderedSha256']);
  if (value.generation !== null && !count(value.generation) || !nullableText(value.renderedPath) || value.renderedSha256 !== null && !digest(value.renderedSha256)) bad('Invalid retained brief.');
}
function admit(kind, value) {
  let profile;
  try { profile=namespaceReaderRecordProfile(kind,value); }
  catch (cause) { throw new SingularityFlowError(cause.message, { cause,
    code: ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code) ? 'ENGINE_STORAGE_UNSUPPORTED' : 'ENGINE_STORAGE_CORRUPT', details: cause.details }); }
  if (value.format !== profile.format) bad('The namespace read record has another format.');
  return profile;
}
export function namespaceReadHead(value, scope, workId) {
  namespaceScope(scope); admit('head', value);
  exactObject(value, ['schemaVersion','format','projectId','workId','state','policy','documents']);
  if (value.projectId !== scope.projectId || value.workId !== workId) bad('The read head belongs to another project or Story.');
  const refs = {};
  for (const [field, namespace] of [['state','state'],['policy','config'],['documents','state']]) {
    refs[field] = contentReference(value[field]);
    if (refs[field].namespace !== namespace) bad('Read projection bytes have another namespace.');
  }
  return { ...value, ...refs };
}

/** A separate profile points at current lifecycle authority, rather than a second state copy. */
export function namespaceReadLifecycleHead(value,scope,workId) {
  namespaceScope(scope);admit('lifecycle-head',value);
  exactObject(value,['schemaVersion','format','projectId','workId','lifecycleHead','authority']);
  exactObject(value.authority,['id','epoch']);
  if(value.projectId!==scope.projectId||value.workId!==workId||!text(value.lifecycleHead)||!text(value.authority.id)
    ||!Number.isSafeInteger(value.authority.epoch)||value.authority.epoch<1)bad('Invalid lifecycle read locator.');
  return value;
}

function brief(value) {
  if (!plain(value)) bad('Invalid retained brief metadata.');
  return { generation: value.generation ?? null, renderedPath: value.renderedPath ?? null, renderedSha256: value.renderedSha256 ?? null };
}

/** Build a read view from an already accepted source; this neither saves it nor accepts that source. */
function readStateData(workflow) {
  return {workItem: { id: workflow.workItem.id, branch: workflow.workItem.branch ?? null }, currentPhase: workflow.currentPhase,
    phases: Object.fromEntries(Object.entries(workflow.phases).map(([id, phase]) => [id, {
      id: phase.id, generation: Number(phase.generation ?? 0), status: phase.status,
      requiredArtifact: { path: phase.requiredArtifact?.path ?? null, kind: phase.requiredArtifact?.kind ?? null },
      artifacts: (phase.artifacts ?? []).map(artifact => ({ path: artifact.path ?? null, sha256: artifact.sha256 ?? null,
        size: artifact.size ?? null, kind: artifact.kind ?? null })), agentBriefs: (phase.agentBriefs ?? []).map(brief)
    }])),
    lineage: { canonicalBranch: workflow.lineage?.canonicalBranch ?? null,
      childBranches: (workflow.lineage?.childBranches ?? []).map(entry => ({ name: entry.name })),
      submissions: (workflow.lineage?.submissions ?? []).map(entry => ({ phase: entry.phase, generation: entry.generation,
        ...(Array.isArray(entry.projection?.agentBriefs) ? { projection: { agentBriefs: entry.projection.agentBriefs.map(brief) } } : {}) })) },
    resolution: { documents: { maxPreviewBytes: workflow.resolution?.documents?.maxPreviewBytes ?? null },
      codeDelivery: { display: { previewBytes: workflow.resolution?.codeDelivery?.display?.previewBytes ?? 4096,
        fullDocumentMaximumBytes: workflow.resolution?.codeDelivery?.display?.fullDocumentMaximumBytes ?? 65536 } } } };
}
/** Historical projection writer remains explicitly v1, including its status-free shape. */
export function projectNamespaceReadState(workflow) {
  return namespaceReadState(namespaceReadRecord('state',readStateData(workflow)),workflow.workItem.id);
}
/** Lifecycle views include explicit terminal state without changing old projection bytes. */
export function projectNamespaceLifecycleReadState(workflow) {
  if(!plain(workflow)||!Object.hasOwn(workflow,'currentPhase'))bad('A lifecycle read view needs its own current-phase binding.');
  const profile=namespaceReaderRecordProfile('state',{schemaVersion:NAMESPACE_READER_SCHEMAS.state.currentVersion});
  return namespaceReadState({schemaVersion:profile.version,format:profile.format,...readStateData(workflow),
    status:Object.hasOwn(workflow,'status')?workflow.status:null},workflow.workItem.id);
}

export function namespaceReadState(value, workId) {
  const profile=admit('state',value).state;
  exactObject(value, ['schemaVersion','format','workItem','currentPhase','phases','lineage','resolution',...(profile.status?['status']:[])]);
  exactObject(value.workItem, ['id','branch']);
  const active=text(value.currentPhase)&&plain(value.phases)&&Object.hasOwn(value.phases,value.currentPhase);
  const terminal=value.currentPhase===null&&profile.terminalStatuses.includes(value.status);
  if (value.workItem.id !== workId || !text(workId) || !nullableText(value.workItem.branch)||!plain(value.phases)
    ||!active&&!terminal||profile.status&&!nullableText(value.status)) bad('The read view does not bind the requested Story and current phase.');
  for (const [id, phase] of Object.entries(value.phases)) {
    exactObject(phase, ['id','generation','status','requiredArtifact','artifacts','agentBriefs']);
    if (!text(id) || phase.id !== id || !count(phase.generation) || !text(phase.status) || !Array.isArray(phase.artifacts) || !Array.isArray(phase.agentBriefs)) bad('Invalid read-view phase.');
    exactObject(phase.requiredArtifact, ['path','kind']);
    if (!nullableText(phase.requiredArtifact.path) || !nullableText(phase.requiredArtifact.kind)) bad('Invalid required artifact.');
    for (const artifact of phase.artifacts) {
      exactObject(artifact, ['path','sha256','size','kind']);
      if (artifact.path !== null && !text(artifact.path) || artifact.sha256 !== null && !digest(artifact.sha256)
        || artifact.size !== null && !count(artifact.size) || !nullableText(artifact.kind)) bad('Invalid retained artifact metadata.');
    }
    for (const value of phase.agentBriefs) validateBrief(value);
  }
  if (!plain(value.lineage) || !Array.isArray(value.lineage.childBranches) || !Array.isArray(value.lineage.submissions)
    || !plain(value.resolution) || !plain(value.resolution.documents) || !plain(value.resolution.codeDelivery?.display)) bad('Invalid read-view lineage or budgets.');
  exactObject(value.lineage, ['canonicalBranch','childBranches','submissions']);
  if (!nullableText(value.lineage.canonicalBranch)) bad('Invalid canonical branch alias.');
  for (const entry of value.lineage.childBranches) { exactObject(entry, ['name']); if (!text(entry.name)) bad('Invalid branch alias.'); }
  for (const entry of value.lineage.submissions) {
    exactObject(entry, ['phase','generation'], ['projection']);
    if (!text(entry.phase) || !count(entry.generation)) bad('Invalid submission view.');
    if (entry.projection) {
      exactObject(entry.projection, ['agentBriefs']); if (!Array.isArray(entry.projection.agentBriefs)) bad('Invalid submitted brief list.');
      for (const value of entry.projection.agentBriefs) validateBrief(value);
    }
  }
  exactObject(value.resolution, ['documents','codeDelivery']); exactObject(value.resolution.documents, ['maxPreviewBytes']);
  exactObject(value.resolution.codeDelivery, ['display']); exactObject(value.resolution.codeDelivery.display, ['previewBytes','fullDocumentMaximumBytes']);
  if (value.resolution.documents.maxPreviewBytes !== null && !count(value.resolution.documents.maxPreviewBytes)
    || !Object.values(value.resolution.codeDelivery.display).every(count)) bad('Invalid read budgets.');
  return value;
}

export function namespaceReadPolicy(value) {
  admit('policy', value); exactObject(value, ['schemaVersion','format','workItemRoot','maximumPreviewBytes']);
  if (!text(value.workItemRoot) || value.workItemRoot.startsWith('/') || value.workItemRoot.includes('\\')
    || value.workItemRoot.split('/').some(part => !part || part === '.' || part === '..')
    || !count(value.maximumPreviewBytes)) bad('Invalid namespace document policy.');
  return value;
}

export function namespaceDocumentIndex(value) {
  admit('documents', value); exactObject(value, ['schemaVersion','format','documents']);
  if (!Array.isArray(value.documents) || value.documents.length > 8192) bad('Invalid document index.');
  const seen = new Set(), ids = new Set();
  for (const document of value.documents) {
    exactObject(document, ['id','phase','generation','sourceKey','role','name','kind','mimeType','encoding','locality','status','aliases','content']);
    if (!text(document.id) || ids.has(document.id) || !text(document.sourceKey) || !['artifact','agent-brief','file'].includes(document.role)
      || !text(document.kind) || !text(document.mimeType) || !['utf8','binary'].includes(document.encoding)
      || !['project','machine-local'].includes(document.locality) || document.phase !== null && !text(document.phase)
      || (document.phase === null ? document.generation !== null : !count(document.generation)) || !nullableText(document.name)
      || !['active','detached'].includes(document.status) || !Array.isArray(document.aliases) || !document.aliases.every(text)
      || document.sourceKey.startsWith('/') || document.sourceKey.includes('\\') || /^[a-zA-Z]:/u.test(document.sourceKey)
      || document.sourceKey.split('/').some(part => !part || part === '.' || part === '..')) bad('Invalid or duplicate document metadata.');
    const key = JSON.stringify([document.phase,document.generation,document.role,document.sourceKey]);
    if (seen.has(key)) bad('The document index binds one member more than once.');
    seen.add(key); ids.add(document.id);
    const reference = contentReference(document.content);
    if (document.locality === 'machine-local' ? reference.namespace !== 'local' : reference.namespace === 'local') bad('Local document bytes require their local content port.');
  }
  return value;
}

export function namespaceReadRecord(kind, value) {
  if (!Object.hasOwn(NAMESPACE_READER_SCHEMAS, kind) || !plain(value) || Object.hasOwn(value, 'schemaVersion') || Object.hasOwn(value, 'format')) bad('Read record metadata must come from its registered profile.');
  // Compatibility builder: new lifecycle state projections use their explicit v2 entry.
  const profile=namespaceReaderRecordProfile(kind,{schemaVersion:1});
  return {schemaVersion:profile.version,format:profile.format,...value};
}

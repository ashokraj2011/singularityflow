import path from 'node:path';
import { gitCommonDir } from '../git-execution.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar, writeMutablePrivateSidecar } from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { canonicalJson } from '../records.mjs';
import { sealMachineLocalPublicationReceipt, verifyMachineLocalPublicationReceipt } from '../publication-machine-integrity.mjs';
import { rcpDigest, rcpFailure, strictObject } from './policy.mjs';

const FAMILIES = new Set(['discovery', 'plan', 'attempt', 'object', 'publication']);
const MAXIMUM_BYTES = 2 * 1024 * 1024;
const RECORD_FIELDS = Object.freeze({
  discovery: ['schemaVersion','kind','repositoryPath','host','effectiveHooksPath','configuration','hooks','setup','inputFiles','gitVersion','observationsOnly','limitations','discoverySha256','runtimeBinding'],
  plan: ['schemaVersion','kind','status','repository','subject','purpose','ref','expectedLocalRef','expectedRemote','prospectiveTree','parents','paths','operationId','ownerGeneration','authority','policySha256','profile','profileSha256','fields','strategy','draftMessage','proposedMessage','messageSha256','tracking','hookBindings','discoverySha256','configurationInputs','runtime','coverage','permittedMessageTransformation','changesAuthorization','approval','planSha256'],
  attempt: ['schemaVersion','kind','repository','subject','planSha256','policySha256','profileSha256','prospectiveTree','messageSha256','tracking','expectedLocalRef','runtime','configurationInputs','hookBindings','status','checks','nativeHookExecution','approval','startedAt','completedAt','execution','commit','stages','effects','actualPrivateIndexTree','diagnostic','finalRemoteOrCiStatus'],
  object: ['schemaVersion','kind','commit','tree','parents','author','committer','message','messageSha256','signature','status','messageRedacted','policyPlan','validation','approval','rawObservation'],
  publication: ['schemaVersion','kind','repository','destinations','checks','status','remoteStatus','approval','plan','diagnosticCode']
});
function recordShape(family, value) {
  strictObject(value, RECORD_FIELDS[family], `RCP ${family} record`);
  if (value.approval != null && value.approval !== 'not-implied') rcpFailure('RCP_RECORD_INVALID', 'A commit-policy record cannot grant human approval.');
  if (value.changesAuthorization === true) rcpFailure('RCP_RECORD_INVALID', 'A serialized policy plan cannot authorize source changes.');
  return value;
}

function directory(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'repository-commit-policy'); }
function checkedId(value) {
  const id = String(value ?? '').replace(/^sha256:/u, '');
  if (!/^[a-f0-9]{64}$/u.test(id)) rcpFailure('RCP_RECORD_INVALID', 'RCP record references require an exact SHA-256.');
  return id;
}
export async function retainCommitPolicyRecord(root, family, value) {
  if (!FAMILIES.has(family)) rcpFailure('RCP_RECORD_INVALID', 'Unsupported RCP record family.');
  const record = { ...value, schemaVersion: currentSchemaVersion(`repository-commit-policy-${family}`), kind: `repository-commit-policy-${family}` };
  recordShape(family, record);
  const sha256 = rcpDigest(record), id = checkedId(sha256);
  await writeImmutablePrivateSidecar(root, path.join(directory(root), 'records', family, `${id}.json`), canonicalJson(record), { maximumBytes: MAXIMUM_BYTES });
  return Object.freeze({ family: `repository-commit-policy-${family}`, sha256 });
}
export async function readCommitPolicyRecord(root, reference) {
  const family = String(reference?.family ?? '').replace(/^repository-commit-policy-/u, '');
  if (!FAMILIES.has(family)) rcpFailure('RCP_RECORD_INVALID', 'Unsupported RCP record reference.');
  const id = checkedId(reference.sha256);
  const bytes = await readPrivateSidecar(root, path.join(directory(root), 'records', family, `${id}.json`), { maximumBytes: MAXIMUM_BYTES });
  const value = JSON.parse(bytes.toString('utf8'));
  if (rcpDigest(value) !== reference.sha256) rcpFailure('RCP_RECORD_INVALID', 'The retained RCP record differs from its immutable identity.');
  return recordShape(family, readRecord(`repository-commit-policy-${family}`, value).record);
}
export async function readCommitPolicyOperation(root, operationId) {
  const id = checkedId(operationId);
  const bytes = await readPrivateSidecar(root, path.join(directory(root), 'operations', `${id}.json`), { maximumBytes: MAXIMUM_BYTES, optional: true });
  if (!bytes) return null;
  const record = readRecord('repository-commit-policy-operation', JSON.parse(bytes.toString('utf8'))).record;
  if (!await verifyMachineLocalPublicationReceipt(root, 'repository-commit-policy-operation', record)) rcpFailure('RCP_RECORD_INVALID', 'The operation’s owner-issued integrity binding is invalid. Preserve recovery records and inspect the existing publication transaction.');
  if (record.operationId !== operationId) rcpFailure('RCP_RECORD_INVALID', 'The operation record belongs to another host action.');
  return record;
}
export async function writeCommitPolicyOperation(root, operationId, value) {
  const id = checkedId(operationId);
  const record = await sealMachineLocalPublicationReceipt(root, 'repository-commit-policy-operation', {
    ...value, schemaVersion: currentSchemaVersion('repository-commit-policy-operation'), kind: 'repository-commit-policy-operation', operationId
  });
  await writeMutablePrivateSidecar(root, path.join(directory(root), 'operations', `${id}.json`), `${JSON.stringify(record)}\n`, { maximumBytes: MAXIMUM_BYTES });
  return record;
}

export async function bindCommitPolicyObject(root, commit, operationId) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) rcpFailure('RCP_RECORD_INVALID', 'An object binding requires its exact Git identity.');
  checkedId(operationId);
  await writeImmutablePrivateSidecar(root, path.join(directory(root), 'objects', `${commit}.json`), canonicalJson({schemaVersion: currentSchemaVersion('repository-commit-policy-object-binding'), commit, operationId}), { maximumBytes: 4096 });
}
export async function operationForCommit(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '')) rcpFailure('RCP_RECORD_INVALID', 'Object lookup requires an exact Git identity.');
  const bytes = await readPrivateSidecar(root, path.join(directory(root), 'objects', `${commit}.json`), { maximumBytes: 4096, optional: true });
  if (!bytes) return null;
  const value = readRecord('repository-commit-policy-object-binding', JSON.parse(bytes.toString('utf8'))).record;
  if (value.commit !== commit) rcpFailure('RCP_RECORD_INVALID', 'The object binding is invalid.');
  return readCommitPolicyOperation(root, value.operationId);
}

/** Portable facts only; host execution grants, local paths and integrity handles are rebound. */
export async function commitPolicyPortableRecords(root, references) {
  if (!Array.isArray(references) || references.length > 128) rcpFailure('RCP_RECORD_INVALID', 'A portable RCP record set must be bounded.');
  const records = [];
  for (const reference of references) {
    const record = await readCommitPolicyRecord(root, reference);
    if (record.authorizationHandle || record.environment || record.argv) rcpFailure('RCP_RECORD_INVALID', 'A host execution handle or environment cannot be exported as portable RCP evidence.');
    records.push({ reference, record });
  }
  return { schemaVersion: 1, kind: 'repository-commit-policy-evidence', records };
}

/** Portable facts are projected beside the existing Flow Ledger, outside their own source commit. */
import {readRecord} from '../schema-migrations.mjs';
import {canonicalJson} from '../records.mjs';
import {operationForCommit,readCommitPolicyRecord} from './records.mjs';
import {rcpDigest,rcpFailure,strictObject} from './policy.mjs';
const valid=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value??'');
const PLAN_FIELDS=['repository','subject','purpose','ref','parents','prospectiveTree','fields','ownerGeneration','draftMessage','proposedMessage','policySha256','profileSha256','profile','strategy','tracking','authority','runtime'];
const OBJECT_FIELDS=['commit','tree','parents','author','committer','message','messageSha256','signature','status'];
const NATIVE_FIELDS=['commit','stages','effects','startedAt','completedAt','beforeMessageSha256','nativeContext','internalLinterObservation','postTransformationCi'];
export const policyEvidencePath=commit=>`evidence/repository-commit-policy/${commit}.json`;
export async function commitPolicyEvidenceFile(root,commit){
 if(!valid(commit))return null;
 const operation=await operationForCommit(root,commit);if(!operation?.observation||!operation.plan)return null;
 const plan=await readCommitPolicyRecord(root,operation.plan),object=await readCommitPolicyRecord(root,operation.observation);
 if(object.status!=='object-verified'||object.commit!==commit)return null;
 const portablePlan=Object.fromEntries(PLAN_FIELDS.map(name=>[name,plan[name]??null]));
 const native=operation.native?Object.fromEntries(NATIVE_FIELDS.map(name=>[name,operation.native[name]??null])):null;
 const facts={schemaVersion:1,kind:'repository-commit-policy-evidence',commit,plan:portablePlan,
  object:Object.fromEntries(OBJECT_FIELDS.map(name=>[name,object[name]??null])),
  native,hostBindings:'must-rebind',executionAuthorization:'not-portable',approval:'not-implied'};
 return {path:policyEvidencePath(commit),text:canonicalJson({...facts,factsSha256:rcpDigest(facts)})};
}
export function verifyPortableCommitPolicyFacts(value,{commit,repository}){
 value=readRecord('repository-commit-policy-evidence',value).record;
 strictObject(value,['schemaVersion','kind','commit','plan','object','native','hostBindings','executionAuthorization','approval','factsSha256'],'portable commit policy facts');
 strictObject(value.plan,PLAN_FIELDS,'portable commit plan');
 strictObject(value.object,OBJECT_FIELDS,'portable commit object');
 if(value.native!=null)strictObject(value.native,NATIVE_FIELDS,'portable native observation');
 if(value.kind!=='repository-commit-policy-evidence')rcpFailure('RCP_RECORD_INVALID','Unsupported portable repository policy evidence.');
 const {factsSha256,...facts}=value;
 if(rcpDigest(facts)!==factsSha256||facts.commit!==commit||facts.plan?.repository!==repository||facts.object?.commit!==commit||facts.object?.status!=='object-verified'
  ||facts.hostBindings!=='must-rebind'||facts.executionAuthorization!=='not-portable'||facts.approval!=='not-implied')rcpFailure('RCP_RECORD_INVALID','The portable policy fact does not match its exact object/repository or includes replayable authority.');
 return facts;
}

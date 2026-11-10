/** Native retained-file verification stays beside the same presence-counted pure evidence rules. */
import {canonicalJson} from './foundation/record-schema.mjs';
import {planCorrectionPolicies,planCorrectionRecordShapes} from './kernel/plan-corrections.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './engine-compatibility/node-configuration-path.mjs';
import {nativeRecordShape} from './engine-compatibility/node-record-shapes.mjs';
import {NODE_TEXT_DIGESTS} from './records.mjs';
import {countedRecords} from './presence/counted.mjs';
import {exactFileAtObject,head} from './git.mjs';
import {readRepositoryManifest} from './repository-manifest.mjs';
import {SingularityFlowError} from './foundation/failures.mjs';
const policies=/* @__PURE__ */ planCorrectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
export const EvidenceAmendmentSchema=/* @__PURE__ */ nativeRecordShape(planCorrectionRecordShapes().evidence);
export const evidenceOwnerAuthorities=/* @__PURE__ */ (()=>policies.evidenceOwnerAuthorities)();
export const evidenceCorrectionProjection=/* @__PURE__ */ (()=>policies.evidenceCorrectionProjection)();
export function applyPlanEvidenceAmendments(record,workflow,options={}){return policies.applyPlanEvidenceAmendments(record,workflow,options,countedRecords(workflow,workflow.planAmendments));}
function invalid(message){throw new SingularityFlowError(message,{code:'PLAN_EVIDENCE_AMENDMENT_INTEGRITY'});}

/** Committed exact decision records are required even while the current draft is dirty. */
export async function verifyPlanEvidenceAmendments(root, workflow, itemRoot) {
  for (const entry of workflow.planAmendments ?? []) {
    if (entry.kind !== 'evidence-contract-correction') continue;
    if (!EvidenceAmendmentSchema.safeParse(entry).success
        || entry.recordPath !== `${itemRoot}/appeals/evidence/${entry.id}.json`) invalid('Evidence amendment has an invalid retained decision path.');
    const committed = exactFileAtObject(root, head(root), entry.recordPath, { maximumBytes: 65536, regularOnly: true });
    if (!committed?.equals(Buffer.from(canonicalJson(entry)))) invalid('Evidence correction is not the exact committed human decision.');
    const current = await readRepositoryManifest(root, entry.recordPath, { maxBytes: 65536 });
    if (current.links?.length || !current.bytes.equals(committed)) invalid('Retained evidence correction was changed after the human decision.');
  }
}

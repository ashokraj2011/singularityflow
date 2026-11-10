/** Native digest binding. TRP rules and wire contracts retain their shared pure owner. */
import {NODE_TEXT_DIGESTS} from './records.mjs';
import {testRecoveryPolicies} from './kernel/test-recovery.mjs';
export {TRP_RISK_CATEGORIES} from './kernel/test-recovery.mjs';
const policy=testRecoveryPolicies(NODE_TEXT_DIGESTS);
export const TRP_EVALUATOR_VERSION=policy.TRP_EVALUATOR_VERSION;
export const TRP_INTEGRITY_CATEGORIES=policy.TRP_INTEGRITY_CATEGORIES;
export const TRP_STALE_CATEGORY=policy.TRP_STALE_CATEGORY;
export const TRP_SCHEMAS=policy.TRP_SCHEMAS;
export const TRP_RECORD_KINDS=policy.TRP_RECORD_KINDS;
export const TRP_POLICY_SCHEMA=policy.TRP_POLICY_SCHEMA;
export const trpDigest=policy.trpDigest;
export const trpEnvironmentDigest=policy.trpEnvironmentDigest;
export const trpRecordDigest=policy.trpRecordDigest;
export const sealTrpRecord=policy.sealTrpRecord;
export const validateTrpRecord=policy.validateTrpRecord;
export const trpIssueIdentity=policy.trpIssueIdentity;
export const evaluateTestRecoveryGate=policy.evaluateTestRecoveryGate;

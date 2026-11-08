import {createRepositoryCommitPolicyCompiler} from '../kernel/configuration-policy.mjs';
import {NODE_RECORD_BYTES,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {invokeCommitPolicyRule} from './diagnostics.mjs';
const compiler=/* @__PURE__ */createRepositoryCommitPolicyCompiler(NODE_RECORD_BYTES,NODE_TEXT_VALUE_SYNTAX);
export {RCP_NAMESPACE,RCP_SCHEMA_VERSION,COMMIT_HOOK_STAGES,RCP_STATUSES,RCP_PURPOSES} from '../kernel/configuration-policy.mjs';
export {rcpFailure} from './diagnostics.mjs';
export function strictObject(value,fields,label) { return invokeCommitPolicyRule(compiler.strictObject,arguments); }
export function rcpDigest(value) { return invokeCommitPolicyRule(compiler.rcpDigest,arguments); }
export function commitTemplateFields(template) { return invokeCommitPolicyRule(compiler.commitTemplateFields,arguments); }
export function normalizeCommitPolicy(value) { return invokeCommitPolicyRule(compiler.normalizeCommitPolicy,arguments); }
export function renderCommitMessage(policy,draft,context) { return invokeCommitPolicyRule(compiler.renderCommitMessage,arguments); }
export function validateCommitMessage(policy,message,context = {}) { return invokeCommitPolicyRule(compiler.validateCommitMessage,arguments); }

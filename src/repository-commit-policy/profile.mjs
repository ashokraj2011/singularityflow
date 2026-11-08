import {createRepositoryCommitPolicyCompiler} from '../kernel/configuration-policy.mjs';
import {NODE_RECORD_BYTES,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {invokeCommitPolicyRule} from './diagnostics.mjs';
const compiler=/* @__PURE__ */createRepositoryCommitPolicyCompiler(NODE_RECORD_BYTES,NODE_TEXT_VALUE_SYNTAX);
export {REGISTERED_COMMIT_CHECKS,REGISTERED_COMMIT_FORMATTERS} from '../kernel/configuration-policy.mjs';
export function policyPath(value) { return invokeCommitPolicyRule(compiler.policyPath,arguments); }
export function normalizeCommitProfile(value,adapter) { return invokeCommitPolicyRule(compiler.normalizeCommitProfile,arguments); }

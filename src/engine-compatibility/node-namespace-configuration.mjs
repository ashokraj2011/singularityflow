/** Node value/runtime binding only; namespace hosts never discover an installed Git authority. */
import { AUTHORING_SKILL_ID, authoringSkillCatalog } from '../authoring-skills.mjs';
import { NODE_RECORD_BYTES, NODE_TEXT_VALUE_SYNTAX, NODE_TEXT_DIGESTS } from '../records.mjs';
import { NODE_CONFIGURATION_PATH_SYNTAX } from './node-configuration-path.mjs';
import { NODE_NETWORK_ADDRESS_SYNTAX } from './node-network-syntax.mjs';
import { COMMIT_POLICY_RUNTIME_PROFILE } from '../kernel/configuration-policy.mjs';
import { createNamespaceConfigurationCompiler } from '../kernel/namespace-configuration.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';

export const NODE_NAMESPACE_CONFIGURATION_COMPILER = createNamespaceConfigurationCompiler({
  AUTHORING_SKILL_ID, authoringSkillCatalog, recordBytes: NODE_RECORD_BYTES, commitTextSyntax: NODE_TEXT_VALUE_SYNTAX,
  networkAddressSyntax: NODE_NETWORK_ADDRESS_SYNTAX, pathSyntax: NODE_CONFIGURATION_PATH_SYNTAX, textDigests: NODE_TEXT_DIGESTS,
  commitPolicyRuntime: Object.freeze({ profile: COMMIT_POLICY_RUNTIME_PROFILE, assertAvailable() {
    // The normalizer is the already imported kernel implementation. Preserve its native Node
    // runtime prerequisite; there is no installed policy-file lookup in this separate host.
    if (!process.features?.require_module) throw new SingularityFlowError('The configured commit policy needs a synchronous-module Node runtime.', { code: 'RCP_RUNTIME_UNSUPPORTED' });
  } })
});

/** Native primitive assembly for shared skill-contract rules. WCA/package owners retain authority. */
import { NODE_CONFIGURATION_PATH_SYNTAX } from './engine-compatibility/node-configuration-path.mjs';
import { NODE_TEXT_DIGESTS } from './records.mjs';
import { createSkillPhaseContractCompiler } from './kernel/skill-phase-contract.mjs';
export { validateSkillPhaseBindingHeader, SKP_CONTRACT_COMPILER, SKP_PHASE_BINDING_VERSION } from './kernel/skill-binding-header.mjs';
const compiler = /* @__PURE__ */ createSkillPhaseContractCompiler(NODE_CONFIGURATION_PATH_SYNTAX, NODE_TEXT_DIGESTS);
export const skillContractSha256 = /* @__PURE__ */ (() => compiler.skillContractSha256)();
export const skillCandidateCatalogSha256 = /* @__PURE__ */ (() => compiler.skillCandidateCatalogSha256)();
export const skillPhaseCandidateSha256 = /* @__PURE__ */ (() => compiler.skillPhaseCandidateSha256)();
export const compileConfirmedSkillPhase = /* @__PURE__ */ (() => compiler.compileConfirmedSkillPhase)();
export const compileSkillPhaseProposal = /* @__PURE__ */ (() => compiler.compileSkillPhaseProposal)();
export const configurationPhaseFromCompiledSkill = /* @__PURE__ */ (() => compiler.configurationPhaseFromCompiledSkill)();
export const validateConfiguredSkillPhase = /* @__PURE__ */ (() => compiler.validateConfiguredSkillPhase)();

import { AST_ASSURANCE } from "./engine-compatibility/node-configuration-path.mjs";
export { AST_MODES, AST_FALLBACKS, AST_ASSURANCE, AST_EVIDENCE_MODES, AST_STORY_START_WARM_MODES, AST_STORY_START_WARM_SCOPES, AST_PREDICATE_TYPES, normalizeAstPolicy } from "./engine-compatibility/node-configuration-path.mjs";

export function assuranceSatisfies(actual, required) {
  return AST_ASSURANCE.indexOf(actual) >= AST_ASSURANCE.indexOf(required);
}

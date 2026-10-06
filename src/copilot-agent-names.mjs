// Copilot display names are exact routing keys, not governed agent IDs or file paths.
// Share their validation with the designer so a name accepted by the UI can be saved
// and resolved by the CLI without stripping meaningful punctuation from its identity.
export const COPILOT_AGENT_MAPPING_NAME_RULE = "be trimmed text starting with a letter or number, use only letters, numbers, spaces, '.', '_', '-', '(' or ')', and be at most 128 characters";

export function validCopilotAgentMappingName(value) {
  return typeof value === 'string' && value === value.trim()
    && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/.test(value);
}

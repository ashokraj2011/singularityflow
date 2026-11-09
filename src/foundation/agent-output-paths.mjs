/** Portable transport-output identities. No filesystem access or lifecycle authority. */
export const AGENT_OUTPUT_FOLDER = '.sflow/out';
export const AGENT_OUTPUT_EXCLUDE = `/${AGENT_OUTPUT_FOLDER}/`;
export function isAgentOutputPath(relative) {
  const value = String(relative ?? '');
  return value === AGENT_OUTPUT_FOLDER || value.startsWith(`${AGENT_OUTPUT_FOLDER}/`);
}

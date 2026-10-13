/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { fileAtRef } from '../../git.mjs';
import { WORKFLOW_PATH, validateDefinition } from '../../config.mjs';
import YAML from 'yaml';

export function definitionAtRef(root, ref) {
  const source = fileAtRef(root, ref, WORKFLOW_PATH);
  if (source == null) return null;
  const definition = YAML.parse(source);
  validateDefinition(definition);
  return definition;
}

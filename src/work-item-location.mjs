import { normalizeWorkItemRoot, DEFAULT_WORK_ITEM_ROOT } from "./engine-compatibility/node-configuration-path.mjs";
export { DEFAULT_WORK_ITEM_ROOT, normalizeWorkItemRoot } from "./engine-compatibility/node-configuration-path.mjs";
import path from 'node:path';
import YAML from 'yaml';

import { SingularityFlowError } from './util.mjs';

export function workItemRootFromDefinitionText(text) {
  return normalizeWorkItemRoot(YAML.parse(String(text ?? ''))?.workItemRoot);
}

export function workItemWorkflowRelative(workId, workItemRoot = DEFAULT_WORK_ITEM_ROOT) {
  const id = String(workId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new SingularityFlowError(`'${id}' is not a safe Work ID.`);
  }
  return path.posix.join(normalizeWorkItemRoot(workItemRoot), id, 'workflow.json');
}

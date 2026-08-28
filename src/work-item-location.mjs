import path from 'node:path';
import YAML from 'yaml';

import { SingularityFlowError } from './util.mjs';

export const DEFAULT_WORK_ITEM_ROOT = 'singularity/work-items';

/** Normalize the configured durable Story root before it is used in a Git object expression. */
export function normalizeWorkItemRoot(value = DEFAULT_WORK_ITEM_ROOT) {
  const candidate = String(value ?? DEFAULT_WORK_ITEM_ROOT).trim().replaceAll('\\', '/');
  if (!candidate || path.posix.isAbsolute(candidate) || /^[A-Za-z]:\//.test(candidate)
      || candidate.split('/').includes('..')) {
    throw new SingularityFlowError('workItemRoot must be a normalized repository-relative path.');
  }
  const root = path.posix.normalize(candidate).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!root || root === '.') {
    throw new SingularityFlowError('workItemRoot must be a normalized repository-relative path.');
  }
  return root;
}

export function workItemRootFromDefinitionText(text) {
  return normalizeWorkItemRoot(YAML.parse(String(text ?? ''))?.workItemRoot);
}

export function workItemWorkflowRelative(workId, workItemRoot = DEFAULT_WORK_ITEM_ROOT) {
  const id = String(workId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new SingularityFlowError(`'${id}' is not a safe governed Work ID.`);
  }
  return path.posix.join(normalizeWorkItemRoot(workItemRoot), id, 'workflow.json');
}

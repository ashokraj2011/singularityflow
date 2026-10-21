/** Canonical Story paths and branch membership, with no lifecycle mutation imports. */
import path from 'node:path';
import { posix } from './util.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';

export function workDir(root, config, id) { return path.join(root, config.workItemRoot ?? 'singularity/work-items', id); }

export function workDirRelative(config, id) { return posix(path.join(config.workItemRoot ?? 'singularity/work-items', id)); }

export function clarificationRecordRelative(definition, workflow, phase, generation = nextPhaseGeneration(phase)) {
  return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    'context', `clarifications-${phase.id}-gen${generation}.json`));
}

export function workflowPath(root, config, id) { return path.join(workDir(root, config, id), 'workflow.json'); }

export function workflowBranchNames(workflow) {
  return [...new Set([
    workflow.workItem.branch,
    workflow.lineage?.canonicalBranch,
    ...(workflow.lineage?.childBranches ?? []).map((entry) => entry.name)
  ].filter(Boolean))];
}

export function workflowBranchAllowed(workflow, branchName) {
  return workflowBranchNames(workflow).includes(branchName);
}


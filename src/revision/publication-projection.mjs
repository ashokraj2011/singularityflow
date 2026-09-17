/** Exact application-byte projection for a selected REV Candidate at Story publication. */
import { head } from '../git.mjs';
import { applicationPathContext, isApplicationPath } from '../application-paths.mjs';
import { recordSha256 } from '../records.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import {
  sgosRevisionCandidateReference, verifySgosRevisionCandidateReference
} from './candidate-adapter.mjs';

const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function refuse(code, message) {
  throw new SingularityFlowError(message, { code });
}

function gitOutput(root, args) {
  return run('git', args, { cwd: root }).stdout;
}

function treeEntries(root, tree, pathContext) {
  if (!GIT_OBJECT.test(String(tree ?? ''))
      || gitOutput(root, ['cat-file', '-t', tree]).trim() !== 'tree') {
    refuse('REV_PUBLICATION_TREE_INVALID', 'Publication must provide an existing exact Git tree.');
  }
  const entries = new Map();
  for (const record of gitOutput(root, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) refuse('REV_PUBLICATION_TREE_INVALID', 'Git tree entry has no path boundary.');
    const path = record.slice(separator + 1);
    if (!isApplicationPath(path, pathContext)) continue;
    if (entries.has(path)) refuse('REV_PUBLICATION_TREE_INVALID', 'Git tree contains a duplicate application path.');
    entries.set(path, record.slice(0, separator));
  }
  return entries;
}

/**
 * Validate the complete application projection, including unmodified application files. The
 * prospective governed commit may add Story metadata, but it may not add, remove, or replace any
 * application blob that is absent from the developer-selected retained Candidate.
 */
export async function verifyRevisionCandidateApplicationTree(root, {
  candidateReference, prospectiveTree, config, workflow
} = {}) {
  if (!candidateReference || candidateReference.family !== 'sgos-candidate'
      || !config || !workflow?.workItem?.id) {
    refuse('REV_PUBLICATION_BINDING_INVALID', 'An exact retained Candidate and Story configuration are required.');
  }
  const subjectId = `${workflow.workItem.id}:${workflow.currentPhase}`;
  if (!await verifySgosRevisionCandidateReference(root, candidateReference, { subjectId })) {
    refuse('REV_PUBLICATION_CANDIDATE_STALE', 'Selected Candidate is not the exact retained Story-phase Candidate.');
  }
  const retained = await sgosRevisionCandidateReference(root, candidateReference.candidateId);
  if (retained.repository.baselineCommit !== head(root)) {
    refuse('REV_PUBLICATION_BASELINE_CHANGED', 'Story HEAD changed after the selected Candidate was frozen.');
  }
  const pathContext = applicationPathContext(config, workflow);
  const baselineTree = gitOutput(root, ['rev-parse', `${retained.repository.baselineCommit}^{tree}`]).trim();
  const candidateTree = retained.repository.candidateTree;
  const changed = gitOutput(root, [
    'diff-tree', '-r', '--name-only', '-z', baselineTree, candidateTree
  ]).split('\0').filter(Boolean);
  const forbidden = changed.filter((path) => !isApplicationPath(path, pathContext));
  if (forbidden.length) {
    refuse('REV_PUBLICATION_CANDIDATE_SCOPE',
      `Selected Candidate changes non-application path(s): ${forbidden.slice(0, 5).join(', ')}.`);
  }
  const selected = treeEntries(root, candidateTree, pathContext);
  const prospective = treeEntries(root, prospectiveTree, pathContext);
  const differences = [...new Set([...selected.keys(), ...prospective.keys()])]
    .filter((path) => selected.get(path) !== prospective.get(path)).sort();
  if (differences.length) {
    refuse('REV_PUBLICATION_CANDIDATE_MISMATCH',
      `The governed publication differs from the selected Candidate at ${differences.slice(0, 5).join(', ')}.`);
  }
  const projection = [...selected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const core = {
    schemaVersion: 1, kind: 'revision-candidate-application-projection',
    workId: workflow.workItem.id, phaseId: workflow.currentPhase,
    candidateId: retained.candidateId,
    candidateSha256: retained.candidateSha256,
    candidateTree, prospectiveTree, baselineCommit: retained.repository.baselineCommit,
    applicationEntriesSha256: `sha256:${recordSha256(projection)}`
  };
  return { ...core, projectionSha256: `sha256:${recordSha256(core)}` };
}

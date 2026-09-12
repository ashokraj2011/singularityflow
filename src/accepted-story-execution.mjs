import path from 'node:path';

import { loadDefinition } from './config.mjs';
import { loadStoryAggregate } from './state-stores.mjs';
import { resolveStoryExecutionDefinition } from './story-execution-context.mjs';
import { branch } from './git.mjs';
import { SingularityFlowError, run } from './util.mjs';

const MAXIMUM_TRACKED_WORKFLOWS = 2048;

function definitionAtWorkItemRoot(definition, workItemRoot) {
  const selected = Object.create(
    Object.getPrototypeOf(definition), Object.getOwnPropertyDescriptors(definition)
  );
  Object.defineProperty(selected, 'workItemRoot', {
    value: workItemRoot, enumerable: true, configurable: true, writable: true
  });
  return selected;
}

function trackedStoryRoots(root) {
  const listed = run('git', ['ls-files', '-z', '--', ':(glob)**/workflow.json'], {
    cwd: root,
    allowFailure: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  });
  if (listed.status !== 0) return [];
  const files = listed.stdout.split('\0').filter(Boolean);
  if (files.length > MAXIMUM_TRACKED_WORKFLOWS) {
    throw new SingularityFlowError(
      `Story discovery found more than ${MAXIMUM_TRACKED_WORKFLOWS} tracked workflow records. Narrow or repair the repository before retrying.`,
      { code: 'WFA_LIMIT_REACHED' }
    );
  }
  return [...new Set(files
    .filter((relative) => path.posix.basename(relative) === 'workflow.json')
    .map((relative) => path.posix.dirname(path.posix.dirname(relative)))
    .filter((relative) => relative && relative !== '.'))].sort();
}

function matchesReference(workflow, reference) {
  if (!reference) return true;
  return [
    workflow?.workItem?.id,
    workflow?.workItem?.branch,
    workflow?.lineage?.canonicalBranch,
    ...(workflow?.lineage?.childBranches ?? []).map((entry) => entry?.name)
  ].filter(Boolean).includes(reference);
}

async function locateAcceptedStory(root, definition, reference = null) {
  let originalError = null;
  try {
    return { definition, workflow: await loadStoryAggregate(root, definition, reference) };
  } catch (error) {
    originalError = error;
  }

  // `workItemRoot` is itself saved Story policy. If today's workflow moves that root, scan only
  // Git-tracked workflow records, derive bounded candidate roots, and let the ordinary aggregate
  // loader validate each candidate. This is not a filesystem/home-directory fallback.
  const matches = [];
  for (const workItemRoot of trackedStoryRoots(root)) {
    if (workItemRoot === definition.workItemRoot) continue;
    const candidateDefinition = definitionAtWorkItemRoot(definition, workItemRoot);
    try {
      const workflow = await loadStoryAggregate(root, candidateDefinition, reference);
      if (matchesReference(workflow, reference)) matches.push({
        definition: candidateDefinition, workflow
      });
    } catch {
      // Another tracked root may contain no matching Story. Only a unique validated match wins.
    }
  }
  const unique = matches.filter((candidate, index) => matches.findIndex((entry) =>
    entry.workflow.workItem.id === candidate.workflow.workItem.id
      && entry.definition.workItemRoot === candidate.definition.workItemRoot) === index);
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw new SingularityFlowError(
      `Story reference '${reference ?? branch(root)}' is ambiguous across tracked Story roots: ${unique.map((entry) => entry.definition.workItemRoot).join(', ')}.`,
      { code: 'WFA_SNAPSHOT_INVALID' }
    );
  }
  throw originalError;
}

/**
 * Load an accepted Story without requiring today's mutable agent catalog or Story root, then
 * install the exact saved execution policy. Machine-local tools, credentials and Git transport
 * remain sourced from the current definition because the resolver overlays only captured policy.
 */
export async function loadAcceptedStoryExecution(root, workId = null) {
  const bootstrap = await loadDefinition(root, { storyBootstrap: true });
  const located = await locateAcceptedStory(root, bootstrap, workId);
  if (located.workflow.workflowSnapshot) {
    const definition = await resolveStoryExecutionDefinition(
      root, located.definition, located.workflow
    );
    return Object.freeze({ definition, config: definition, workflow: located.workflow });
  }
  const current = await loadDefinition(root);
  const legacy = await locateAcceptedStory(root, current, workId);
  return Object.freeze({
    definition: legacy.definition, config: legacy.definition, workflow: legacy.workflow
  });
}

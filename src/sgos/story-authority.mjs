/**
 * Exact, immutable Story authority for an SGOS Process.
 *
 * A caller-supplied Work ID is not authority.  This module proves that the Story exists in the
 * exact Git commit used as the Process baseline, validates the durable Story contract, and returns
 * the path/blob/state digests that the Process Binding pins.  No working-tree bytes participate in
 * that authority.
 */
import { createHash } from 'node:crypto';

import { readRefTreeResult } from '../git-ref-tree.mjs';
import { canonicalJson } from '../records.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, run } from '../util.mjs';
import {
  workItemRootFromDefinitionText, workItemWorkflowRelative
} from '../work-item-location.mjs';
import { sgosSha256 } from './evidence.mjs';

const EXACT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFINITION_PATH = 'singularity/workflow.yml';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function exactTreeContent(root, revision, relative, { optional = false } = {}) {
  const observed = readRefTreeResult(root, revision, [relative], {
    filter: (candidate) => candidate === relative
  });
  if (observed.status !== 'ok') {
    fail(`Governed Story state at '${revision}' is unavailable.`,
      'SGOS_STORY_STATE_UNAVAILABLE', {
        revision,
        path: relative,
        status: observed.status,
        diagnostics: observed.errors.map((entry) => entry.code)
      });
  }
  const content = observed.contents.get(relative);
  if (content == null && !optional) {
    fail(`Governed Story state '${relative}' does not exist at the Process baseline.`,
      'SGOS_STORY_STATE_UNAVAILABLE', { revision, path: relative, status: 'missing' });
  }
  return content ?? null;
}

export function assertExactSgosBaselineRevision(root, revision) {
  const exact = String(revision ?? '');
  if (!EXACT_COMMIT.test(exact)) {
    fail('The SGOS Process is not bound to an exact Git commit.',
      'SGOS_STORY_BASELINE_INVALID', { revision: exact || null });
  }
  const resolved = run('git', ['rev-parse', '--verify', `${exact}^{commit}`], {
    cwd: root,
    allowFailure: true,
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never'
    }
  });
  if (resolved.status !== 0 || resolved.stdout.trim() !== exact) {
    fail('The SGOS Process baseline commit is unavailable locally.',
      'SGOS_STORY_BASELINE_UNAVAILABLE', { revision: exact });
  }
  return exact;
}

function storyPath(root, revision, subjectId) {
  const definition = exactTreeContent(root, revision, DEFINITION_PATH, { optional: true });
  try {
    return workItemWorkflowRelative(
      subjectId,
      workItemRootFromDefinitionText(definition ?? '')
    );
  } catch (error) {
    fail('The Process baseline does not declare a safe governed Story-state path.',
      'SGOS_STORY_STATE_PATH_INVALID', {
        revision, subjectId, cause: error?.message ?? String(error)
      });
  }
}

/** Resolve and validate one governed Story strictly from an exact Git commit. */
export function loadSgosStoryAuthority(root, { subjectId, revision } = {}) {
  const exactRevision = assertExactSgosBaselineRevision(root, revision);
  const id = String(subjectId ?? '').trim();
  const relative = storyPath(root, exactRevision, id);
  const content = exactTreeContent(root, exactRevision, relative);
  const blobSha256 = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
  const stateSourceSha256 = sgosSha256({
    kind: 'sgos-governed-story-state-source',
    revision: exactRevision,
    path: relative,
    blobSha256
  });
  let state;
  try {
    state = readRecord('story-workflow', JSON.parse(content)).record;
  } catch (error) {
    fail('The exact Process-baseline Story state failed its durable schema contract.',
      'SGOS_STORY_STATE_INVALID', {
        revision: exactRevision,
        path: relative,
        stateSourceSha256,
        cause: error?.message ?? String(error)
      });
  }
  if (state?.workItem?.id !== id) {
    fail('The Process-baseline Story state belongs to another governed subject.',
      'SGOS_STORY_STATE_SUBJECT_MISMATCH', {
        expectedSubjectId: id,
        observedSubjectId: state?.workItem?.id ?? null,
        revision: exactRevision,
        path: relative,
        stateSourceSha256
      });
  }
  const stateSha256 = sgosSha256({
    kind: 'sgos-observed-story-state',
    stateSourceSha256,
    state
  });
  return Object.freeze({
    authority: Object.freeze({
      kind: 'governed-story-baseline',
      subjectId: id,
      revision: exactRevision,
      path: relative,
      blobSha256,
      stateSha256
    }),
    state: Object.freeze(structuredClone(state)),
    stateSourceSha256
  });
}

export function assertSgosStoryAuthority(expected, observed) {
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    fail('Governed Story authority does not match the exact Process baseline.',
      'SGOS_STORY_AUTHORITY_MISMATCH', { expected, observed });
  }
  return observed;
}

/** Refuse mutable Story bytes that differ from the authority already pinned at Process start. */
export function assertSgosWorkingStoryMatchesAuthority(root, authority, stateSourceSha256) {
  const compared = run('git', [
    'diff', '--quiet', '--no-ext-diff', '--no-textconv', authority.revision, '--', authority.path
  ], {
    cwd: root,
    allowFailure: true,
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never'
    }
  });
  if (compared.status === 1) {
    fail('Working-tree Story state differs from the exact Process baseline; mutable state was not attested.',
      'SGOS_STORY_STATE_DIVERGED', {
        revision: authority.revision,
        path: authority.path,
        expectedStateSourceSha256: stateSourceSha256
      });
  }
  if (compared.status !== 0) {
    fail('Git could not prove that working-tree Story state matches the exact Process baseline.',
      'SGOS_STORY_STATE_ATTESTATION_UNAVAILABLE', {
        revision: authority.revision,
        path: authority.path,
        expectedStateSourceSha256: stateSourceSha256
      });
  }
}

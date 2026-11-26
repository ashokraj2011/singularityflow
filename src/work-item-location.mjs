import path from 'node:path';
import YAML from 'yaml';

import { SingularityFlowError } from './util.mjs';
import { DEFAULT_WORK_ITEM_ROOT, STORY_LAYOUTS, storyLocation } from './story-paths.mjs';

export { DEFAULT_WORK_ITEM_ROOT };

/**
 * `story` in workflow.yml [SSB:REQ-010]: `storage` chooses where a NEW Story keeps SFlow's records. `story-branch`
 * (today's, the default until the release that ships SSB) keeps them on the Story's branch; `state-ref` keeps them on
 * the Story's own state ref, checked out at `.sflow-state/`. A Story keeps the layout it started with.
 */
export function normalizeStoryPolicy(value) {
  const route = { nextAction: { command: 'singularity-flow workflow validate', label: 'Set story.storage to story-branch or state-ref.' } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('story must be a mapping, such as story: { storage: story-branch }.', { code: 'STORY_STORAGE_SETTING_INVALID', details: route });
  }
  for (const key of Object.keys(value)) {
    if (key !== 'storage') throw new SingularityFlowError(`story.${key} is not a setting. Use story.storage (${STORY_LAYOUTS.join(' or ')}).`, { code: 'STORY_STORAGE_SETTING_INVALID', details: route });
  }
  const storage = value.storage ?? 'story-branch';
  if (!STORY_LAYOUTS.includes(storage)) throw new SingularityFlowError(`story.storage must be ${STORY_LAYOUTS.join(' or ')}.`, { code: 'STORY_STORAGE_SETTING_INVALID', details: route });
  return { storage };
}

/**
 * The layout a NEW Story starts with [SSB:REQ-010]. `state-ref` is not finished (SSB M3 to M5), so until M5's build fence
 * it is held back: a Story whose configuration asks for it starts on today's layout, records that for life, and says so
 * in one line. Only SFlow's own tests and builders turn the preview on; nothing tells a person to.
 */
export const STORY_STATE_REF_PREVIEW = 'SINGULARITY_FLOW_STORY_STATE_REF_PREVIEW';
export const STORY_STATE_REF_HELD = 'Story records on their own Git ref are not finished yet; this Story keeps them on its branch as today.';
export function newStoryLayout(definition, env = process.env) {
  if (definition?.story?.storage !== 'state-ref') return { layout: 'story-branch', held: false };
  return env?.[STORY_STATE_REF_PREVIEW] === '1' ? { layout: 'state-ref', held: false }
    : { layout: 'story-branch', held: true, notice: STORY_STATE_REF_HELD };
}

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
    throw new SingularityFlowError(`'${id}' is not a safe Work ID.`);
  }
  return storyLocation(null, { workItemRoot: normalizeWorkItemRoot(workItemRoot) }, id).record('workflow.json');
}

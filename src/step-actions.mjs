export { STEP_ACTION_TRIGGERS, STEP_ACTION_SENDS, MAX_STEP_ACTIONS, MAX_INTEGRATION_TARGETS, DEFAULT_TARGET_TIMEOUT_SECONDS, MAX_TARGET_TIMEOUT_SECONDS, INTEGRATION_TARGET_KINDS, HTTP_LOG_FORMATS, validDeliveryBranchName, STEP_ACTION_DELIVERERS, assertSecretName, assertTargetUrl, jiraTransitionFor, normalizeIntegrations, normalizeStepActions, pinStepActions, stepActionTriggers, storyRequiresStepActions, actionsForTrigger } from './kernel/step-action-policy.mjs';
/**
 * After-step actions: what a workflow step sends to other systems once it is submitted, approved or
 * rejected.
 *
 * A step lists actions under `afterStep`. Each action names a target (a connection declared once
 * under `integrations.targets`), the triggers it fires on, and what it sends. Configuration holds
 * only the names of secrets, never their values. When a Story starts, each action is pinned with its
 * target's settings inside the pinned step, so a running Story keeps the actions it started with and
 * Story records keep their format and version.
 *
 * Actions copy approved content outward. Nothing a target returns changes governed state, and a
 * failed delivery never undoes a transition.
 *
 * Policy validation lives in kernel/step-action-policy.mjs. This compatibility owner retains
 * native event/delivery hashing, target rendering and event summaries.
 */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from './util.mjs';
export const STEP_ACTION_EVENT_SCHEMA = 'sflow-step-action@1';
/**
 * Integration secrets have their own namespace. Configuration chooses which secret a target sends
 * and where, so without it a workflow could name another tool's credential (JIRA_PAT, GITHUB_TOKEN,
 * a cloud key) as a target's token and deliver it to an address of its choosing.
 */
export const INTEGRATION_SECRET_PREFIX = 'SFLOW_SECRET_';
export const DEFAULT_ONEDRIVE_FOLDER = 'sflow/{story}/{step}/generation-{generation}';

/** The drive folder an upload goes to, from the target's folder template and one delivery. */
export function renderOneDriveFolder(template, { workId, phaseId, generation, trigger }) {
  const safe = (value) => String(value ?? '').replace(/[^A-Za-z0-9 ._()-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[ .-]+|[ .]+$/g, '').slice(0, 120) || 'x';
  const values = { story: safe(workId), step: safe(phaseId), generation: String(Number.isSafeInteger(generation) ? generation : 0), trigger: safe(trigger) };
  return String(template ?? DEFAULT_ONEDRIVE_FOLDER).replace(/\{([a-z]+)\}/g, (_, name) => values[name] ?? name);
}
export const DEFAULT_CONFLUENCE_TITLE = '{story} — {step}';

/** The page title a Confluence delivery writes: one page per Story and step. */
export function renderConfluenceTitle(template, { workId, stepLabel, storyTitle }) {
  const values = { story: String(workId ?? ''), step: String(stepLabel ?? ''), storyTitle: String(storyTitle ?? '') };
  return String(template ?? DEFAULT_CONFLUENCE_TITLE).replace(/\{([A-Za-z]+)\}/g, (_, name) => values[name] ?? name)
    .replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 255);
}
export const DEFAULT_GIT_DELIVERY_PATH = 'sflow/{story}/{step}/{file}';

/** The file a Git delivery writes, from the target's path template and one delivery. */
export function renderGitDeliveryPath(template, { workId, phaseId, generation, trigger, artifactPath }) {
  // One path segment each: no separator, no leading dot, no run of dots, no trailing dot.
  const safe = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|\.+$/g, '').slice(0, 120) || 'x';
  const values = {
    story: safe(workId), step: safe(phaseId), generation: String(Number.isSafeInteger(generation) ? generation : 0),
    trigger: safe(trigger), file: safe(String(artifactPath ?? 'artifact.md').split('/').pop())
  };
  return String(template ?? DEFAULT_GIT_DELIVERY_PATH).replace(/\{([a-z]+)\}/g, (_, name) => values[name] ?? name);
}

/**
 * The identity of one delivery: a retry of the same Story, step, generation, trigger and action is
 * the same delivery, so it is sent at most once.
 */
export function stepActionDeliveryKey({ workId, phaseId, generation, trigger, actionId }) {
  for (const [name, value] of Object.entries({ workId, phaseId, trigger, actionId })) {
    if (typeof value !== 'string' || !value) throw new SingularityFlowError(`A delivery key needs ${name}.`, { code: 'STEP_ACTION_INVALID' });
  }
  if (!Number.isSafeInteger(generation) || generation < 0) throw new SingularityFlowError('A delivery key needs a generation number.', { code: 'STEP_ACTION_INVALID' });
  const digest = createHash('sha256').update(JSON.stringify(['sflow-step-action-delivery@1', workId, phaseId, generation, trigger, actionId])).digest('hex');
  return `sad_${digest.slice(0, 40)}`;
}

function portablePath(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.replace(/\\/g, '/');
  // Machine paths never leave the machine: only repository-relative paths are sent.
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * The event every action sends, in the portable shape targets receive. It names the Story, the
 * step, what happened and the commit that records it, and lists each artifact by path and SHA-256.
 * It never carries source code, diffs, prompts, secrets or paths on someone's machine. `summary` and
 * `artifact` content is added by the caller only for actions that ask for it.
 */
export function buildStepActionEvent({
  workflow, phaseId, trigger, action, deliveryKey, event = {}, commit = null, remote = null, decision = null
}) {
  const phase = workflow?.phases?.[phaseId] ?? {};
  const resolved = (workflow?.resolution?.phases ?? []).find((entry) => entry.id === phaseId) ?? {};
  const artifacts = (phase.artifacts ?? [])
    .map((artifact) => ({ path: portablePath(artifact?.path), sha256: typeof artifact?.sha256 === 'string' ? artifact.sha256 : null }))
    .filter((artifact) => artifact.path);
  return {
    schema: STEP_ACTION_EVENT_SCHEMA,
    delivery: { key: deliveryKey, action: action.id, target: action.target, trigger, send: action.send },
    story: {
      id: workflow?.workItem?.id ?? null,
      title: workflow?.workItem?.title ?? null,
      workflow: workflow?.resolution?.workType ?? workflow?.workType ?? null,
      branch: workflow?.workItem?.branch ?? event.subject?.branch ?? null,
      jiraKey: typeof workflow?.lineage?.currentJiraKey === 'string' ? workflow.lineage.currentJiraKey : null,
      baseBranch: typeof workflow?.workItem?.baseBranch === 'string' ? workflow.workItem.baseBranch : null
    },
    step: {
      id: phaseId,
      label: resolved.label ?? phase.label ?? phaseId,
      generation: Number.isSafeInteger(phase.generation) ? phase.generation : (Number.isSafeInteger(event.generation) ? event.generation : 0),
      status: phase.status ?? null
    },
    actor: event.actor ?? null,
    at: event.createdAt ?? null,
    commit: commit ? { sha: commit, remote } : null,
    artifacts,
    decision
  };
}

const MAX_SUMMARY_CRITERIA = 20;
const MAX_SUMMARY_TEXT = 300;

function clip(text, limit = MAX_SUMMARY_TEXT) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * The title and acceptance criteria of a Markdown artifact, for actions that send `summary`:
 * enough for a person to recognise the work, never the whole document.
 */
export function summarizeArtifact(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const title = lines.map((line) => /^#\s+(.+)$/.exec(line)?.[1]).find(Boolean) ?? null;
  const criteria = [];
  let inCriteria = false;
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (inCriteria && heading[1].length <= level) inCriteria = false;
      if (/acceptance criteria/i.test(heading[2])) { inCriteria = true; level = heading[1].length; }
      continue;
    }
    if (!inCriteria || criteria.length >= MAX_SUMMARY_CRITERIA) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)?.[1];
    const row = /^\s*\|(.+)\|\s*$/.exec(line)?.[1];
    if (item) criteria.push(clip(item));
    else if (row && !/^[\s|:-]+$/.test(row)) {
      const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length && !/^clause$/i.test(cells[0])) criteria.push(clip(cells.join(' — ')));
    }
  }
  return { title: title ? clip(title, 200) : null, acceptanceCriteria: criteria };
}

const TRIGGER_WORDS = Object.freeze({ submitted: 'submitted for approval', approved: 'approved', rejected: 'sent back' });

/** One readable message for chat and log services: what happened, to which Story, and where. */
export function stepActionText(event) {
  const step = event?.step?.label ?? event?.step?.id ?? 'A step';
  const story = [event?.story?.id, event?.story?.title].filter(Boolean).join(' ');
  const lines = [`Singularity Flow — ${step} ${TRIGGER_WORDS[event?.delivery?.trigger] ?? event?.delivery?.trigger ?? 'changed'}`];
  if (story) lines.push(`${story}${Number.isSafeInteger(event?.step?.generation) ? ` · generation ${event.step.generation}` : ''}`);
  const where = [event?.story?.branch ? `Branch ${event.story.branch}` : null, event?.commit?.sha ? `commit ${event.commit.sha.slice(0, 12)}` : null].filter(Boolean);
  if (where.length) lines.push(where.join(' · '));
  if (event?.decision?.returnedTo) lines.push(`Returned to ${event.decision.returnedTo}${event.decision.reason ? `: ${clip(event.decision.reason, 200)}` : ''}`);
  if (event?.summary?.title) lines.push(`${event.summary.title}`);
  for (const criterion of (event?.summary?.acceptanceCriteria ?? []).slice(0, 5)) lines.push(`• ${criterion}`);
  return lines.join('\n');
}

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
 * This module is pure: configuration, the Workflow Studio model, the delivery runtime and VS Code
 * all read it, so it carries no YAML, file-system or network code.
 */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from './util.mjs';

export const STEP_ACTION_TRIGGERS = Object.freeze(['submitted', 'approved', 'rejected']);
export const STEP_ACTION_SENDS = Object.freeze(['event', 'summary', 'artifact']);
export const STEP_ACTION_EVENT_SCHEMA = 'sflow-step-action@1';
export const MAX_STEP_ACTIONS = 16;
export const MAX_INTEGRATION_TARGETS = 32;
export const DEFAULT_TARGET_TIMEOUT_SECONDS = 10;
export const MAX_TARGET_TIMEOUT_SECONDS = 30;

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * Integration secrets have their own namespace. Configuration chooses which secret a target sends
 * and where, so without it a workflow could name another tool's credential (JIRA_PAT, GITHUB_TOKEN,
 * a cloud key) as a target's token and deliver it to an address of its choosing.
 */
export const INTEGRATION_SECRET_PREFIX = 'SFLOW_SECRET_';
const SECRET_NAME = /^SFLOW_SECRET_[A-Z0-9_]{1,51}$/;
const LABEL_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// A value under one of these keys would be a secret written into reviewed configuration.
const INLINE_SECRET_KEY = /^(?:token|password|passwd|secret|apikey|api[-_]?token|key|signingkey|authorization|auth|bearer|credentials?)$/i;
// A query parameter with one of these names usually carries a credential or a signature.
const SECRET_QUERY_KEY = /token|secret|signature|^sig$|key|code|password|auth/i;

/**
 * Every kind a target may name. `available` is true once this build can deliver to it; a kind that
 * is not yet available is refused by configuration instead of being accepted and doing nothing.
 */
export const INTEGRATION_TARGET_KINDS = Object.freeze({
  webhook: Object.freeze({ available: true, label: 'Webhook', sends: Object.freeze(['event', 'summary']) }),
  'http-log': Object.freeze({ available: true, label: 'Log service', sends: Object.freeze(['event', 'summary']) }),
  teams: Object.freeze({ available: true, label: 'Microsoft Teams', sends: Object.freeze(['event', 'summary']) }),
  jira: Object.freeze({ available: true, label: 'Jira', sends: Object.freeze(['event', 'summary', 'artifact']) }),
  git: Object.freeze({ available: false, label: 'Git', sends: Object.freeze(['artifact']) }),
  confluence: Object.freeze({ available: false, label: 'Confluence', sends: Object.freeze(['summary', 'artifact']) }),
  onedrive: Object.freeze({ available: false, label: 'OneDrive or SharePoint', sends: Object.freeze(['artifact']) })
});

export const HTTP_LOG_FORMATS = Object.freeze(['json', 'splunk-hec', 'datadog', 'elastic', 'loki']);
const TOKEN_REQUIRED_FORMATS = new Set(['splunk-hec', 'datadog', 'elastic']);

/** The fields each available kind accepts, besides `kind`, `label`, `network` and `timeoutSeconds`. */
const TARGET_FIELDS = Object.freeze({
  webhook: Object.freeze(['url', 'signingSecret']),
  'http-log': Object.freeze(['url', 'format', 'tokenSecret', 'labels']),
  teams: Object.freeze(['urlSecret']),
  jira: Object.freeze(['issue', 'transition'])
});
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const COMMON_TARGET_FIELDS = Object.freeze(['kind', 'label', 'network', 'timeoutSeconds']);

function refuse(code, message, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A secret is named, never written: the value comes from the environment on the delivering machine. */
export function assertSecretName(value, label) {
  if (typeof value !== 'string' || !SECRET_NAME.test(value)) {
    refuse('INTEGRATION_SECRET_NAME_INVALID',
      `${label} must name an environment secret that starts with SFLOW_SECRET_, such as SFLOW_SECRET_EVENTS_KEY, and never hold its value. `
        + 'Integration secrets have their own names so a workflow can never send another tool\'s credentials, such as JIRA_PAT or GITHUB_TOKEN.',
      { location: label });
  }
  return value;
}

/**
 * Where a target may deliver: HTTPS, or plain HTTP to this machine only; no credentials, fragment
 * or credential-bearing query parameters in the address, because configuration is reviewed and
 * committed.
 */
export function assertTargetUrl(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    refuse('INTEGRATION_TARGET_URL_INVALID', `${label} must be an https:// address of at most 2048 characters.`, { location: label });
  }
  let url;
  try { url = new URL(value); } catch {
    refuse('INTEGRATION_TARGET_URL_INVALID', `${label} is not a valid address.`, { location: label });
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    refuse('INTEGRATION_TARGET_URL_INVALID', `${label} must use https:// (plain http:// is allowed only for this machine, such as http://127.0.0.1).`, { location: label });
  }
  if (url.username || url.password) {
    refuse('INTEGRATION_SECRET_INLINE', `${label} contains credentials. Remove them from the address and name a secret instead.`, { location: label });
  }
  if (url.hash) refuse('INTEGRATION_TARGET_URL_INVALID', `${label} must not contain a #fragment.`, { location: label });
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key)) {
      refuse('INTEGRATION_SECRET_INLINE',
        `${label} carries a '${key}' query parameter, which usually holds a credential. Keep the address free of credentials and name a secret instead.`,
        { location: label, parameter: key });
    }
  }
  return url.toString();
}

function assertNoInlineSecrets(raw, label) {
  for (const key of Object.keys(raw)) {
    if (INLINE_SECRET_KEY.test(key)) {
      refuse('INTEGRATION_SECRET_INLINE',
        `${label} has '${key}', which would put a secret in reviewed configuration. Name an environment secret instead, for example tokenSecret: MY_SERVICE_TOKEN.`,
        { location: label, field: key });
    }
  }
}

/** One status (or transition) for every trigger, or one per trigger: { submitted, approved, rejected }. */
function normalizeJiraTransition(value, label) {
  const one = (text, where) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 80 || CONTROL_CHARACTERS.test(text)) {
      refuse('INTEGRATION_TARGET_INVALID', `${where} must name a Jira status or transition of at most 80 characters.`, { location: label });
    }
    return text.trim();
  };
  if (typeof value === 'string') return one(value, `${label} transition`);
  if (!plainObject(value) || !Object.keys(value).length) {
    refuse('INTEGRATION_TARGET_INVALID', `${label} transition must be a status name, or one per trigger such as { approved: Done }.`, { location: label });
  }
  const byTrigger = {};
  for (const trigger of Object.keys(value)) {
    if (!STEP_ACTION_TRIGGERS.includes(trigger)) {
      refuse('INTEGRATION_TARGET_INVALID', `${label} transition names '${trigger}'; it accepts ${STEP_ACTION_TRIGGERS.join(', ')}.`, { location: label });
    }
  }
  for (const trigger of STEP_ACTION_TRIGGERS) {
    if (value[trigger] != null) byTrigger[trigger] = one(value[trigger], `${label} transition.${trigger}`);
  }
  return byTrigger;
}

/** The Jira status a target moves its issue to for one trigger, if any. */
export function jiraTransitionFor(target, trigger) {
  if (typeof target?.transition === 'string') return target.transition;
  return target?.transition?.[trigger] ?? null;
}

function normalizeTarget(id, raw, label) {
  if (!plainObject(raw)) refuse('INTEGRATION_TARGET_INVALID', `${label} must be an object with a kind.`, { location: label });
  assertNoInlineSecrets(raw, label);
  const kind = raw.kind;
  const declared = Object.hasOwn(INTEGRATION_TARGET_KINDS, kind) ? INTEGRATION_TARGET_KINDS[kind] : null;
  if (!declared) {
    refuse('INTEGRATION_TARGET_KIND_UNKNOWN',
      `${label} kind must be one of: ${Object.keys(INTEGRATION_TARGET_KINDS).join(', ')}.`, { location: label, kind });
  }
  if (!declared.available) {
    refuse('INTEGRATION_TARGET_KIND_UNAVAILABLE',
      `${label} uses kind '${kind}', which this build cannot deliver to yet. Available now: ${Object.entries(INTEGRATION_TARGET_KINDS).filter(([, entry]) => entry.available).map(([name]) => name).join(', ')}.`,
      { location: label, kind });
  }
  const allowed = new Set([...COMMON_TARGET_FIELDS, ...TARGET_FIELDS[kind]]);
  for (const key of Object.keys(raw)) {
    if (key === 'id' && raw.id === id) continue;
    if (!allowed.has(key)) {
      refuse('INTEGRATION_TARGET_FIELD_UNKNOWN',
        `${label} has unknown field '${key}'. A ${kind} target accepts: ${[...allowed].join(', ')}.`, { location: label, field: key });
    }
  }
  const target = { id, kind };
  if (raw.label != null) {
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 80) {
      refuse('INTEGRATION_TARGET_INVALID', `${label} label must be text of at most 80 characters.`, { location: label });
    }
    target.label = raw.label.trim();
  }
  if (kind === 'jira') {
    // Jira is reached through this machine's Jira connection (JIRA_BASE_URL), never an address the
    // configuration chooses, so the address rules do not apply to it.
    if (raw.network != null) {
      refuse('INTEGRATION_TARGET_INVALID', `${label} is a Jira target: it uses the Jira connection on the delivering machine, so network does not apply.`, { location: label });
    }
  } else {
    const network = raw.network ?? 'public';
    if (!['public', 'private'].includes(network)) {
      refuse('INTEGRATION_TARGET_INVALID', `${label} network must be public or private.`, { location: label });
    }
    if (kind === 'teams' && network !== 'public') {
      refuse('INTEGRATION_TARGET_INVALID', `${label} is a Teams webhook, which is always a public address.`, { location: label });
    }
    target.network = network;
  }
  const timeout = raw.timeoutSeconds ?? DEFAULT_TARGET_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TARGET_TIMEOUT_SECONDS) {
    refuse('INTEGRATION_TARGET_INVALID', `${label} timeoutSeconds must be a whole number from 1 to ${MAX_TARGET_TIMEOUT_SECONDS}.`, { location: label });
  }
  target.timeoutSeconds = timeout;
  if (kind === 'webhook') {
    target.url = assertTargetUrl(raw.url, `${label} url`);
    if (raw.signingSecret != null) target.signingSecret = assertSecretName(raw.signingSecret, `${label} signingSecret`);
  } else if (kind === 'http-log') {
    target.url = assertTargetUrl(raw.url, `${label} url`);
    const format = raw.format ?? 'json';
    if (!HTTP_LOG_FORMATS.includes(format)) {
      refuse('INTEGRATION_TARGET_INVALID', `${label} format must be one of: ${HTTP_LOG_FORMATS.join(', ')}.`, { location: label });
    }
    target.format = format;
    if (raw.tokenSecret != null) target.tokenSecret = assertSecretName(raw.tokenSecret, `${label} tokenSecret`);
    else if (TOKEN_REQUIRED_FORMATS.has(format)) {
      refuse('INTEGRATION_TARGET_INVALID', `${label} writes to ${format}, which needs tokenSecret: the name of the secret holding its API token.`, { location: label });
    }
    if (raw.labels != null) {
      if (!plainObject(raw.labels) || Object.keys(raw.labels).length > 16) {
        refuse('INTEGRATION_TARGET_INVALID', `${label} labels must be an object of at most 16 text values.`, { location: label });
      }
      target.labels = {};
      for (const [key, value] of Object.entries(raw.labels)) {
        if (!LABEL_KEY.test(key) || typeof value !== 'string' || value.length > 200) {
          refuse('INTEGRATION_TARGET_INVALID', `${label} label '${key}' must be a short name with a text value of at most 200 characters.`, { location: label });
        }
        target.labels[key] = value;
      }
    }
  } else if (kind === 'teams') {
    if (raw.urlSecret == null) {
      refuse('INTEGRATION_TARGET_INVALID',
        `${label} needs urlSecret: the Teams webhook address carries its own credential, so it is named as a secret, for example SFLOW_SECRET_TEAMS_URL.`,
        { location: label });
    }
    target.urlSecret = assertSecretName(raw.urlSecret, `${label} urlSecret`);
  } else if (kind === 'jira') {
    if (raw.issue != null) {
      if (typeof raw.issue !== 'string' || !JIRA_ISSUE_KEY.test(raw.issue)) {
        refuse('INTEGRATION_TARGET_INVALID', `${label} issue must be a Jira issue key such as OPS-12. Leave it out to write to the issue each Story was started from.`, { location: label });
      }
      target.issue = raw.issue;
    }
    if (raw.transition != null) target.transition = normalizeJiraTransition(raw.transition, label);
  }
  return target;
}

/** `integrations` from workflow.yml, checked strictly. Absent means no targets. */
export function normalizeIntegrations(raw) {
  if (raw == null) return { targets: {} };
  if (!plainObject(raw)) refuse('INTEGRATION_TARGET_INVALID', 'integrations must be an object with targets.', { location: 'integrations' });
  for (const key of Object.keys(raw)) {
    if (key !== 'targets') refuse('INTEGRATION_TARGET_FIELD_UNKNOWN', `integrations has unknown field '${key}'. It accepts: targets.`, { location: 'integrations', field: key });
  }
  const targets = raw.targets ?? {};
  if (!plainObject(targets)) refuse('INTEGRATION_TARGET_INVALID', 'integrations.targets must be an object of named targets.', { location: 'integrations.targets' });
  const ids = Object.keys(targets);
  if (ids.length > MAX_INTEGRATION_TARGETS) {
    refuse('INTEGRATION_TARGET_INVALID', `integrations.targets may name at most ${MAX_INTEGRATION_TARGETS} targets.`, { location: 'integrations.targets' });
  }
  const normalized = {};
  for (const id of ids) {
    if (!ID.test(id) || id.length > 63) {
      refuse('INTEGRATION_TARGET_INVALID', `Integration target '${id}' must be a lower-case name such as team-events.`, { location: `integrations.targets.${id}` });
    }
    normalized[id] = normalizeTarget(id, targets[id], `Integration target '${id}'`);
  }
  return { targets: normalized };
}

/**
 * A step's `afterStep` list, checked against the declared targets. `null` or absent means the
 * step sends nothing. Returned actions are in the written order.
 */
export function normalizeStepActions(raw, integrations, label) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) refuse('STEP_ACTION_INVALID', `${label} afterStep must be a list of actions.`, { location: label });
  if (raw.length > MAX_STEP_ACTIONS) refuse('STEP_ACTION_INVALID', `${label} afterStep may list at most ${MAX_STEP_ACTIONS} actions.`, { location: label });
  const targets = integrations?.targets ?? {};
  const seen = new Set();
  return raw.map((action, index) => {
    const where = `${label} afterStep[${index}]`;
    if (!plainObject(action)) refuse('STEP_ACTION_INVALID', `${where} must be an object with id, on and target.`, { location: where });
    for (const key of Object.keys(action)) {
      if (!['id', 'on', 'target', 'send'].includes(key)) {
        refuse('STEP_ACTION_FIELD_UNKNOWN', `${where} has unknown field '${key}'. An action accepts: id, on, target, send.`, { location: where, field: key });
      }
    }
    if (typeof action.id !== 'string' || !ID.test(action.id) || action.id.length > 63) {
      refuse('STEP_ACTION_INVALID', `${where} id must be a lower-case name such as announce.`, { location: where });
    }
    if (seen.has(action.id)) refuse('STEP_ACTION_INVALID', `${label} afterStep names action '${action.id}' twice.`, { location: where });
    seen.add(action.id);
    const on = action.on;
    if (!Array.isArray(on) || !on.length || new Set(on).size !== on.length || on.some((trigger) => !STEP_ACTION_TRIGGERS.includes(trigger))) {
      refuse('STEP_ACTION_INVALID', `${where} on must list one or more of: ${STEP_ACTION_TRIGGERS.join(', ')}.`, { location: where });
    }
    if (typeof action.target !== 'string' || !Object.hasOwn(targets, action.target)) {
      const known = Object.keys(targets);
      refuse('STEP_ACTION_TARGET_UNKNOWN',
        `${where} names target '${action.target}', which integrations.targets does not declare.${known.length ? ` Declared: ${known.join(', ')}.` : ' Declare it under integrations.targets first.'}`,
        { location: where, target: action.target });
    }
    const send = action.send ?? 'event';
    if (!STEP_ACTION_SENDS.includes(send)) refuse('STEP_ACTION_INVALID', `${where} send must be one of: ${STEP_ACTION_SENDS.join(', ')}.`, { location: where });
    const kind = targets[action.target].kind;
    if (!INTEGRATION_TARGET_KINDS[kind].sends.includes(send)) {
      refuse('STEP_ACTION_SEND_UNSUPPORTED',
        `${where} sends '${send}' to a ${kind} target, which accepts: ${INTEGRATION_TARGET_KINDS[kind].sends.join(', ')}.`, { location: where, kind, send });
    }
    return { id: action.id, on: STEP_ACTION_TRIGGERS.filter((trigger) => on.includes(trigger)), target: action.target, send };
  });
}

/**
 * Pin each action with its target's settings. The pinned list lives in the Story's resolved step,
 * so later edits to a target never change what a running Story sends. Secrets stay names.
 */
export function pinStepActions(actions, integrations) {
  const targets = integrations?.targets ?? {};
  return actions.map((action) => ({ ...action, targetSpec: structuredClone(targets[action.target]) }));
}

/**
 * Which triggers a committed lifecycle event fires for its step. Triggers follow the step's state
 * after the transition, not the event name: a submit that approved itself fires `approved`, and an
 * approval that has not yet reached the step's threshold fires nothing.
 */
export function stepActionTriggers(eventType, phase) {
  if (!phase) return [];
  if (eventType === 'approval-requested') {
    if (phase.status === 'awaiting_approval') return ['submitted'];
    if (phase.status === 'approved') return ['approved'];
    return [];
  }
  if (eventType === 'phase-approved') return phase.status === 'approved' ? ['approved'] : [];
  if (eventType === 'phase-rejected') return ['rejected'];
  return [];
}

/** The pinned actions of a step that fire for a trigger, in the written order. */
export function actionsForTrigger(resolvedPhase, trigger) {
  return (resolvedPhase?.afterStep ?? []).filter((action) => action.on.includes(trigger));
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
      jiraKey: typeof workflow?.lineage?.currentJiraKey === 'string' ? workflow.lineage.currentJiraKey : null
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

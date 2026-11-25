import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkoutScope } from './ask/history-cursor.mjs';
import { askConversationId, evidenceId, prepareTaskSources, readTaskSelection, taskSources } from './ask/task-handoff.mjs';
import { assertWorkTypeStartable, resolveWorkType, WORKFLOW_PATH } from './config.mjs';
import { kindOf, launchTask, nextTaskWorkId, taskPlanForWords } from './commands/work.mjs';
import { configuredRemoteAuthority } from './git-remote-diagnostics.mjs';
import { remoteDefaultBranchName } from './git.mjs';
import { operationContext } from './operation-context.mjs';
import { recordSha256 } from './records.mjs';
import { loadConfig } from './state-stores.mjs';
import { admitTask, assertTaskAdmissionOwner, inspectTaskAdmission, prepareTaskAdmission, taskAdmissionId, taskAdmissionOrigin } from './task-admission.mjs';
import { taskDefinition as overlay, taskRules } from './task-composition.mjs';
import { optionStrings, SingularityFlowError } from './util.mjs';
import { validateId } from './work-id.mjs';
import { normalizeWorkItemRoot } from './work-item-location.mjs';

const fail = (code, message) => new SingularityFlowError(message, { code });
const invalid = () => fail('TASK_HANDOFF_REQUEST_INVALID', 'Prepare a task from a saved Ask selection, or inspect or start a single handoff by ID. See singularity-flow work --help.');
const readOptions = new Set(['for-person', 'json', 'model', 'timings', 'start']);
const prepareOptions = new Set(['conversation', 'revision', 'request', 'kind', 'target', 'clause', 'supporting-evidence', 'admission-key']);

function requestOf(positionals, options) {
  if (options['for-person'] !== true || Object.hasOwn(options, 'for-agent')) {
    throw fail('TASK_HANDOFF_PERSON_REQUIRED', 'Prepare or start this task from your own Ask SFlow view or terminal with --for-person.');
  }
  const id = positionals[2];
  if (positionals.length > 3 || (id && !taskAdmissionId.test(id)) ||
      Object.keys(options).some(key => !readOptions.has(key) && (id || !prepareOptions.has(key))) ||
      Object.entries(options).some(([key, value]) => Array.isArray(value) && !['clause', 'supporting-evidence'].includes(key)) ||
      (options.start !== undefined && (options.start !== true || !id))) throw invalid();
  if (id) return { id, start: options.start === true };
  const { conversation: conversationId, revision: rawRevision, request, kind, target, 'admission-key': key } = options;
  const revision = Number(rawRevision);
  const words = typeof request === 'string' ? request.trim() : '';
  const evidence = optionStrings(options, 'supporting-evidence');
  const clauses = optionStrings(options, 'clause');
  if (!askConversationId.test(conversationId ?? '') || typeof rawRevision !== 'string' || !/^[1-9][0-9]*$/u.test(rawRevision) ||
      !Number.isSafeInteger(revision) || !words || words.length > 2000 || words.includes('\0') ||
      (kind !== undefined && typeof kind !== 'string') || (target !== undefined && !evidenceId.test(target)) ||
      (key !== undefined && !taskAdmissionId.test(key)) || evidence.length > 7 || evidence.some(value => !evidenceId.test(value)) ||
      clauses.length > 32 || clauses.some(value => !/^(?:SPEC-[A-Z0-9-]+:)?(?:REQ|BEH|IFC|AC|CON)-\d{3,}$/iu.test(value) || value.length > 160)) throw invalid();
  return { conversationId, revision, target, evidence, clauses, key, words, kind: kindOf(words, options) };
}

function authority(root, remote) {
  return ['fetch', 'push'].map(direction => configuredRemoteAuthority(root, remote, { direction }).fingerprint);
}

async function taskDefinition(root) {
  if (!existsSync(path.join(root, WORKFLOW_PATH))) throw fail('TASK_REPOSITORY_NOT_SET_UP', 'Set up SFlow in this checkout before starting a task.');
  return loadConfig(root);
}

const phasePlan = resolved => resolved.phases.map(phase => ({ id: phase.id, intent: phase.intent ?? null, approval: phase.approval ?? null }));

function reviewedPlan(definition, preview) {
  return recordSha256({ composition: preview.composition, steps: preview.steps,
    phases: phasePlan(assertWorkTypeStartable(resolveWorkType(definition, preview.composition.workType))) });
}

async function startTask(root, id) {
  let definition;
  return admitTask(root, id, {
    async validate(request) {
      definition = await taskDefinition(root);
      const target = request.target;
      if (target.checkout !== await checkoutScope(root, {}, 'person')) {
        throw fail('TASK_ADMISSION_CHECKOUT_CHANGED', 'Open the original Ask checkout to start this prepared task.');
      }
      const remote = definition.git?.remote ?? 'origin';
      if (remote !== target.remote || recordSha256(authority(root, remote)) !== target.authoritySha256 ||
          normalizeWorkItemRoot(definition.workItemRoot) !== target.workItemRoot) {
        throw fail('TASK_ADMISSION_TARGET_CHANGED', 'The repository destination or Story storage changed. Prepare a new task plan.');
      }
      const preview = await taskPlanForWords(definition, request.words, { kind: request.kind });
      if (recordSha256(preview) !== request.planSha256) throw fail('TASK_ADMISSION_PLAN_CHANGED', 'The workflow plan changed. Prepare a new task plan.');
      await taskSources(root, root, definition, request.sources);
      return preview;
    },
    reserve(request, reserved) {
      const workId = nextTaskWorkId(root, taskRules(definition).idPrefix, { remote: request.target.remote, reserved });
      validateId(definition, workId);
      return workId;
    },
    async dispatch(record, preview) {
      const { request, workId } = record;
      const { target, sources } = request;
      const origin = taskAdmissionOrigin(record);
      return launchTask(workId, { words: request.words, base: target.base, preview, json: true, isolated: target.remoteConfigured,
        admission: { origin, async verify(selectedRoot, definition, remote) {
          await assertTaskAdmissionOwner(selectedRoot, record);
          if (remote !== target.remote ||
              target.workItemRoot !== normalizeWorkItemRoot(definition.workItemRoot) ||
              recordSha256(authority(selectedRoot, remote)) !== target.authoritySha256 ||
              reviewedPlan(definition, preview) !== request.reviewedPlanSha256) {
            throw fail('TASK_ADMISSION_PLAN_CHANGED', 'The approved Story destination or workflow changed. Prepare a new task plan.');
          }
          return { specification: await taskSources(selectedRoot, root, definition, sources),
            taskHandoff: { admissionId: origin.admissionId, requestSha256: origin.requestSha256,
              origin: 'ask-conversation', specification: sources.specification, evidence: sources.evidence } };
        } }
      });
    }
  });
}

export function handoffView(record) {
  const { id, status, workId, request, outcome, diagnostic } = record;
  const command = `singularity-flow work handoff ${id} --for-person`;
  const actions = [{ id: 'inspect', label: 'Check this handoff', command }];
  const replan = ['TASK_ADMISSION_PLAN_CHANGED', 'TASK_ADMISSION_TARGET_CHANGED', 'TASK_SPEC_PIN_STALE'].includes(diagnostic?.code);
  if ((status === 'prepared' || status === 'refused' || status === 'unknown') && !replan) {
    actions.push({ id: 'start', label: status === 'prepared' ? 'Start this task' : 'Retry this reservation', command: command + ' --start' });
  }
  if (status === 'accepted') actions.push({ id: 'status', label: 'View task status', command: `singularity-flow work status ${workId}` });
  if (outcome?.pendingPush) actions.push({ id: 'publish', label: 'Retry the retained publication', command: `singularity-flow push retry ${outcome.pendingPush} --json` });
  else if (outcome?.publicationPending) actions.push({ id: 'publish', label: 'Inspect pending publication', command: 'singularity-flow push status --json' });
  if (status === 'unknown') actions.push({ id: 'recover', label: 'Inspect repository recovery', command: 'singularity-flow doctor --json' });
  const message = {
    prepared: 'Task prepared. Review its selected evidence and start it when ready.',
    pending: 'This task is starting. Check the same handoff for its result.',
    accepted: `Task ${workId} is recorded.`,
    refused: 'Story start was refused. The handoff is retained.',
    unknown: 'Story start could not be verified. This handoff keeps the original reservation.'
  }[status];
  return { schemaVersion: 1, resultType: 'sflow-task-handoff', id, status, workId, message, intent: request.words, // schema-transient: ITW handoff view
    kind: request.kind, plan: request.plan, steps: request.steps, base: request.target.base,
    specification: request.sources.specification, evidence: request.sources.evidence, outcome, diagnostic: diagnostic ?? null, actions };
}

export async function workHandoff(positionals, options) {
  const input = requestOf(positionals, options);
  const root = operationContext()?.root;
  if (!root) throw fail('TASK_ADMISSION_CHECKOUT_REQUIRED', 'Open the original Ask checkout to use this handoff.');
  if (input.id) {
    const task = await (input.start ? startTask(root, input.id) : inspectTaskAdmission(root, input.id));
    const view = handoffView(task);
    if (task.status === 'accepted' && task.request.origin?.conversationId?.startsWith('askp-')) {
      Object.assign(view, await (await import('./ask/portable-task.mjs')).syncSharedTask(root, task));
    }
    return view;
  }

  const selection = await readTaskSelection(root, input);
  const definition = await taskDefinition(root);
  const preview = await taskPlanForWords(definition, input.words, { kind: input.kind });
  const sources = await prepareTaskSources(root, definition, selection);
  const remote = definition.git?.remote ?? 'origin';
  const authorities = authority(root, remote);
  const target = { checkout: await checkoutScope(root, {}, 'person'), remote, authoritySha256: recordSha256(authorities),
    remoteConfigured: Boolean(authorities[0]), base: remoteDefaultBranchName(root, definition, remote) ?? 'main',
    workItemRoot: normalizeWorkItemRoot(definition.workItemRoot) };
  const request = { effect: 'work.start', origin: { conversationId: input.conversationId, interaction: 'prepare-task' },
    words: input.words, kind: input.kind, target, sources, plan: preview.plan, steps: preview.steps, planSha256: recordSha256(preview),
    reviewedPlanSha256: reviewedPlan(overlay(definition, preview.composition), preview) };
  if (selection.conversation.shared) {
    const key = input.key ?? selection.store.taskKey(selection.conversation.id, recordSha256(request));
    const previous = selection.conversation.taskAdmissionId;
    if (previous && previous !== key) {
      throw fail('TASK_ADMISSION_KEY_CONFLICT', 'Inspect the existing task handoff or start a new Ask conversation for a different task.');
    }
    // Claim the shared context before creating any actionable receipt on this device.
    const conversation = previous ? selection.conversation
      : await selection.store.update(selection.conversation.id, selection.conversation.revision, { taskAdmissionId: key });
    const prepared = await prepareTaskAdmission(root, request, { key });
    return { ...handoffView(await inspectTaskAdmission(root, prepared.id)), conversation: { id: conversation.id, revision: conversation.revision } };
  }
  const prepared = await prepareTaskAdmission(root, request, { key: input.key });
  let conversation;
  try {
    conversation = selection.conversation.taskAdmissionId === prepared.id
      ? await selection.store.read(selection.conversation.id, selection.conversation.revision)
      : await selection.store.update(selection.conversation.id, selection.conversation.revision, { taskAdmissionId: prepared.id });
  } catch (error) {
    if (error.code !== 'ASK_CONVERSATION_CONFLICT') throw error;
    throw new SingularityFlowError('The Ask conversation changed while the task was prepared. Its exact handoff is still available.', {
      code: error.code, details: { ...error.details, admissionId: prepared.id,
        nextAction: `singularity-flow work handoff ${prepared.id} --for-person` }
    });
  }
  return { ...handoffView(await inspectTaskAdmission(root, prepared.id)), conversation: { id: conversation.id, revision: conversation.revision } };
}

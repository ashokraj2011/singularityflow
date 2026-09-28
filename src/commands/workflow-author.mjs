/** Shared inert drafts, deterministic previews and separately confirmed review proposals. */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { TextDecoder } from 'node:util';
import { captureTerminalActionAuthorization } from '../action-authorization.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { configurationReadRoot } from '../configuration-read-scope.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { draftDeletePlan, openGitDraftStore } from '../wca-git-drafts.mjs';
import { SingularityFlowError, isPortableRepositoryPathComponent } from '../util.mjs';
import { parseLocalStoryInventorySubjects, SKP_STORY_INVENTORY_LIMITS } from '../skp-story-inventory-request.mjs';
import { parseCrossRepositoryStoryInventorySubjects } from '../skp-cross-repository-story-inventory.mjs';

export const WORKFLOW_AUTHOR_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const PAYLOAD_MAX_BYTES = 256 * 1024;
const ASSET_MAX_BYTES = 4 * 1024 * 1024;
const ACTIONS = new Set(['list', 'read', 'create', 'save', 'history', 'op-status', 'delete', 'show', 'preview', 'catalog', 'submit', 'where-used']);
const OPTIONS = {
  list: new Set(['json', 'limit', 'cursor']),
  read: new Set(['json', 'revision']),
  create: new Set(['json', 'name', 'input', 'operation-id', 'expected-head', 'expected-authority']),
  save: new Set(['json', 'name', 'input', 'operation-id', 'expected-head', 'expected-authority', 'epoch']),
  history: new Set(['json', 'limit', 'cursor']),
  'op-status': new Set(['json']),
  delete: new Set(['json', 'operation-id']),
  show: new Set(['json', 'revision']),
  preview: new Set(['json', 'revision']),
  catalog: new Set(['json', 'kind', 'limit', 'cursor']),
  submit: new Set(['json', 'revision']),
  'where-used': new Set(['json', 'package-sha256', 'limit', 'cursor', 'expected-source', 'story', 'ref', 'commit', 'snapshot-revision', 'story-refs', 'repository-story-refs', 'history-depth'])
};
const DRAFT_ID = /^WFD-[A-Z0-9]{6,32}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const APPROVED_STARTER = /^@approved-starter\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const EFFECTS_NONE = Object.freeze({ stateChanged: false, filesChanged: false,
  publicationCreated: false, externalSystemsChanged: false });

function fail(message, code = 'WCA_AUTHOR_REQUEST_INVALID') {
  throw new SingularityFlowError(message, { code });
}
function numberOption(options, name, minimum, maximum, fallback) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)
      || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    fail(`--${name} requires one integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

/** Entry preflight must run before repository selection or any shared-store contact. */
export function validateWorkflowAuthorRequest({ positionals, options }) {
  const action = positionals[2] ?? 'list';
  if (!ACTIONS.has(action)) fail('Use workflow author list, read, create, save, history, op-status, delete, show, preview, catalog, submit, or where-used.');
  const length = positionals.length;
  if (action === 'list' ? ![2, 3].includes(length) : action === 'catalog' ? length !== 3
    : action === 'create' ? ![3, 4].includes(length) : length !== 4) {
    fail(`workflow author ${action} has an invalid target selection.`);
  }
  for (const [key, value] of Object.entries(options)) {
    if (!OPTIONS[action].has(key) || (key === 'json' ? value !== true
      : typeof value !== 'string' || !value.trim())) {
      fail(`workflow author ${action} does not support the supplied --${key} value.`);
    }
  }
  const target = positionals[3];
  if (action === 'where-used') {
    if (typeof target !== 'string' || target.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(target)) fail('Select one bounded portable skill ID.');
    for (const key of ['package-sha256', 'expected-source']) {
      if (options[key] !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(options[key])) fail(`--${key} requires one exact SHA-256 digest.`);
    }
    const crossInventory = options['repository-story-refs'] !== undefined;
    const inventory = options['story-refs'] !== undefined || crossInventory;
    if (numberOption(options, 'cursor', 0, inventory ? SKP_STORY_INVENTORY_LIMITS.references : 1024, 0) > 0 && options['expected-source'] === undefined) fail('Later usage pages require --expected-source from the preceding page.');
    if (crossInventory && options['story-refs'] !== undefined) fail('Select either local --story-refs or explicit --repository-story-refs.');
    if (inventory) {
      if (['story', 'ref', 'commit', 'snapshot-revision'].some((key) => options[key] !== undefined)) {
        fail('Story inventories cannot be mixed with single-Story revision selectors.');
      }
      const historyDepth = numberOption(options, 'history-depth', 1, SKP_STORY_INVENTORY_LIMITS.historyDepth, 1);
      if (crossInventory) parseCrossRepositoryStoryInventorySubjects(options['repository-story-refs'], historyDepth);
      else parseLocalStoryInventorySubjects(options['story-refs'], historyDepth);
    } else if (options['history-depth'] !== undefined) fail('--history-depth requires explicit Story/ref selectors; no Story scan is performed.');
    if (options.story !== undefined && (options.story.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(options.story)
        || !isPortableRepositoryPathComponent(options.story))) fail('--story requires one exact bounded portable Story ID.');
    if (options.story === undefined && ['ref', 'commit', 'snapshot-revision'].some((key) => options[key] !== undefined)) fail('Historical selectors require one explicitly selected --story; no Story scan is performed.');
    if (options.ref !== undefined && (options.ref.length > 512 || !(options.ref === 'HEAD' || /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(options.ref)) || /(?:\.\.|@\{|\/\/|\/$|\.lock(?:\/|$))/u.test(options.ref))) fail('--ref requires HEAD or one literal local refs/heads or refs/remotes ref.');
    if (options.commit !== undefined && !HEAD.test(options.commit)) fail('--commit requires one exact local Git commit object ID reachable from the selected ref.');
    numberOption(options, 'snapshot-revision', 1, 64, null);
    if (options.story !== undefined) numberOption(options, 'cursor', 0, 512, 0);
  } else if (target !== undefined && (action === 'op-status' ? !OPERATION_ID.test(target) : !DRAFT_ID.test(target))) {
    fail(action === 'op-status' ? 'Select one bounded operation ID.' : 'Select one exact WFD draft ID.');
  }
  for (const key of ['operation-id']) {
    if (options[key] !== undefined && !OPERATION_ID.test(options[key])) fail('Select one bounded operation ID.');
  }
  if (['create', 'save'].includes(action)) {
    if (options['operation-id'] === undefined || options['expected-head'] === undefined) {
      fail('Draft writes require --operation-id and the exact --expected-head from a fresh read or list.');
    }
    if (!HEAD.test(options['expected-head']) && !(action === 'create' && options['expected-head'] === 'empty')) {
      fail('--expected-head must be an exact Git object ID; empty is allowed only for an empty-store create.');
    }
  }
  if (action === 'save' && (options.epoch === undefined || (!options.input && !options.name))) {
    fail('Draft save requires --epoch and a selected --input file or --name change.');
  }
  if (options.name !== undefined && (Buffer.byteLength(options.name) > 512 || /[\0\r\n]/u.test(options.name))) {
    fail('Draft display name must be bounded single-line text.');
  }
  if (options['expected-authority'] !== undefined
      && (Buffer.byteLength(options['expected-authority']) > 4096 || /[\0\r\n]/u.test(options['expected-authority']))) {
    fail('--expected-authority requires one bounded exact repository observation. It never selects a destination.');
  }
  numberOption(options, 'limit', 1, 64, 20);
  numberOption(options, 'cursor', 0, action === 'where-used' && (options['story-refs'] !== undefined
    || options['repository-story-refs'] !== undefined) ? SKP_STORY_INVENTORY_LIMITS.references : 1024, 0);
  numberOption(options, 'revision', 1, 256, null);
  numberOption(options, 'epoch', 1, 1, 1);
  if (action === 'submit' && options.revision === undefined) fail('Submission requires one exact --revision from a saved preview.');
  if (options.kind !== undefined && !['phase', 'template', 'agent', 'workflow', 'execution-task', 'quality-command', 'approval-authority'].includes(options.kind)) {
    fail('Select one supported captured catalog kind.');
  }
  return action;
}

function rejectDuplicateKeys(text) {
  const stack = [];
  let nodes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === '\\') index += 1;
        else if (text[index] === '"') break;
      }
      const context = stack.at(-1);
      if (context?.keys && context.expectsKey) {
        const key = JSON.parse(text.slice(start, index + 1));
        if (context.keys.has(key)) fail('Draft input contains duplicate JSON fields.', 'WCA_INPUT_INVALID');
        context.keys.add(key); context.expectsKey = false;
      }
    } else if (char === '{' || char === '[') {
      if (++nodes > 100_000 || stack.length >= 32) fail('Draft input exceeds its structural budget.', 'WCA_INPUT_LIMIT');
      stack.push(char === '{' ? { keys: new Set(), expectsKey: true } : {});
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).expectsKey = true;
  }
}

/** Selected transport bytes are bounded, UTF-8, literal and never interpreted as a host package. */
export async function readWorkflowAuthorInput(file) {
  let handle;
  let bytes;
  try {
    const selected = await lstat(file, { bigint: true });
    if (!selected.isFile() || selected.size > BigInt(WORKFLOW_AUTHOR_INPUT_MAX_BYTES)) {
      fail('Draft input must be a bounded regular file, not a symlink or special file.', 'WCA_INPUT_LIMIT');
    }
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      | (fsConstants.O_NONBLOCK ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino
        || before.size > BigInt(WORKFLOW_AUTHOR_INPUT_MAX_BYTES)) fail('Draft input selection changed.', 'WCA_INPUT_INVALID');
    const buffer = Buffer.allocUnsafe(WORKFLOW_AUTHOR_INPUT_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > WORKFLOW_AUTHOR_INPUT_MAX_BYTES) fail('Draft input exceeds its byte budget.', 'WCA_INPUT_LIMIT');
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail('Draft input changed while it was being captured.', 'WCA_INPUT_INVALID');
    }
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail('The selected draft input file could not be read.', 'WCA_INPUT_UNAVAILABLE');
  } finally {
    if (handle) await handle.close();
  }
  let input;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    input = JSON.parse(text);
    rejectDuplicateKeys(text);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail('Draft input must be valid UTF-8 JSON.', 'WCA_INPUT_INVALID');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['payload', 'assets'].includes(key))
      || !Object.keys(input).length) fail('Draft input is a closed payload/assets envelope.', 'WCA_INPUT_INVALID');
  if (Object.hasOwn(input, 'payload') && (!input.payload || typeof input.payload !== 'object'
    || Array.isArray(input.payload) || Buffer.byteLength(canonicalJson(input.payload)) > PAYLOAD_MAX_BYTES)) {
    fail('Draft input requires a partial JSON object within the interactive payload budget.', 'WCA_INPUT_LIMIT');
  }
  if (Object.hasOwn(input, 'assets')) {
    if (!Array.isArray(input.assets) || input.assets.length > 64) fail('Draft asset count exceeds its budget.', 'WCA_INPUT_LIMIT');
    let total = 0;
    for (const asset of input.assets) {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)
          || Object.keys(asset).sort().join('\0') !== 'content\0path'
          || typeof asset.path !== 'string' || typeof asset.content !== 'string'
          || !asset.path.isWellFormed() || !asset.content.isWellFormed()) {
        fail('Draft assets require a logical path and exact well-formed literal text.', 'WCA_INPUT_INVALID');
      }
      total += Buffer.byteLength(asset.content);
      if (total > ASSET_MAX_BYTES) fail('Draft assets exceed the interactive byte budget.', 'WCA_INPUT_LIMIT');
    }
  }
  return input;
}

/** Read an exact starter from the freshly verified approved authority, not the app checkout. */
export async function readApprovedWorkflowStarterInput(root, scope, selected) {
  const match = APPROVED_STARTER.exec(selected);
  if (!match || match[1].length > 64 || !isPortableRepositoryPathComponent(match[1])) {
    fail('Select one portable approved starter ID.', 'WCA_INPUT_INVALID');
  }
  const relative = `singularity/templates/starter-packs/${match[1]}/draft-input.json`;
  return withApprovedConfigurationRead(root, async (authority) => {
    if (authority?.remote !== scope.remote
        || authority?.commit !== scope.approvedConfiguration?.commit
        || authority?.ref !== scope.approvedConfiguration?.ref) {
      fail('Approved configuration changed after draft scope selection. List drafts again before retrying.',
        'WCA_DRAFT_AUTHORITY_CHANGED');
    }
    return readWorkflowAuthorInput(path.join(configurationReadRoot(root), relative));
  }, { preferAuthority: true, requireAuthorityRefresh: true, allowLocalHeads: false,
    selectPaths: ['singularity/workflow.yml', relative] });
}

function scopeView(scope) {
  return { workspaceId: scope.workspaceId, remote: scope.remote,
    approvedConfiguration: scope.approvedConfiguration ?? { status: 'unavailable' } };
}
function nextRoute(argv) {
  const guidance = safeCommandGuidance({ executable: 'singularity-flow', argv });
  return guidance ? { argv, command: guidance.command, copilotCommand: guidance.copilotCommand } : { argv };
}
function showView(selected, scope, preview) {
  const terminalReview = preview.skillFinalization?.status === 'requires-exact-terminal-consent';
  const missingDecisions = preview.findings.map((finding) => ({ ...finding,
    label: finding.message, status: terminalReview && finding.code === 'WCA_SKP_CONFIRMATION_BINDING_PENDING'
      ? 'requires-terminal-review' : 'unresolved' }));
  const payload = selected.payload;
  for (const [fieldPath, label] of [['id', 'Package identity'], ['label', 'Package label']]) {
    if (typeof payload[fieldPath] !== 'string' || !payload[fieldPath].trim()) {
      missingDecisions.push({ fieldPath, label, requiredFor: 'submission', status: 'unresolved' });
    }
  }
  if (payload.intent === 'create' && (!Array.isArray(payload.definitions?.workflows)
      || !payload.definitions.workflows.length)) {
    missingDecisions.push({ fieldPath: 'definitions.workflows', label: 'Workflow definitions and stage order',
      requiredFor: 'submission', status: 'unresolved' });
  }
  const proposalReady = !selected.tombstone
    && missingDecisions.every((decision) => decision.status === 'requires-terminal-review')
    && (terminalReview || (preview.readiness.authoring === 'valid'
      && preview.readiness.simulation === 'complete-for-profile'));
  const view = {
    kind: 'workflow-authoring-show-view',
    subject: { kind: 'draft', draftId: selected.record.draftId, revision: selected.record.revision,
      lifecycleEpoch: selected.record.lifecycleEpoch, revisionSha256: selected.record.revisionSha256,
      lifecycle: selected.tombstone ? 'deleted' : 'live' },
    displayName: selected.record.displayName,
    assessment: { status: preview.readiness.authoring, definitionGapCount: missingDecisions.filter((decision) => decision.status === 'unresolved').length,
      coverage: preview.coverage, execution: 'not-started',
      simulation: preview.readiness.simulation,
      approval: 'not-granted', publication: 'not-proposed', activation: 'inactive',
      host: 'unverified', policy: scope.approvedConfiguration ?? { status: 'unavailable' } },
    graph: { nodes: preview.graph, edges: preview.graph.flatMap((node) => node.inputs.map((input) => ({
      workflowId: node.workflowId, from: input, to: node.phaseId }))), coverage: preview.coverage.graph },
    preview,
    missingDecisions,
    assets: selected.assets.map((asset) => ({ path: asset.path, bytes: asset.content.length })),
    durability: { status: 'shared-acknowledged', head: selected.head, revision: selected.record.revision },
    capabilities: { guide: 'vscode-six-stage', completePackageCompiler: 'deterministic-preview',
      submission: 'separate-terminal-review', automaticSaving: 'vscode-opt-in', nativeHostConfirmation: 'unavailable' },
    primaryAction: proposalReady
      ? { operationId: 'workflow.author.submit', draftId: selected.record.draftId,
        reasonCode: terminalReview ? 'exact-skill-package-terminal-review-required' : 'complete-package-terminal-review-required',
        effect: 'separate-terminal-review-only',
        requiresCurrentRevision: true, ...nextRoute(['workflow', 'author', 'submit', selected.record.draftId, '--revision', String(selected.record.revision), '--json']) }
      : missingDecisions.length && !selected.tombstone ? { operationId: 'workflow.author.save',
      draftId: selected.record.draftId, reasonCode: 'draft-definition-incomplete',
      effect: 'edit-inert-draft', requiresCurrentRevision: true } : null
  };
  // Transport acknowledgements can change when another draft advances the store. They do not
  // change the assessment of this exact retained revision or silently rebase its semantic digest.
  const { durability, ...semanticView } = view;
  return { ...view, viewSha256: `sha256:${recordSha256(semanticView)}` };
}

function emit(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`${value.operation.id}: ${value.status}`);
    if (value.data?.view) {
      const view = value.data.view;
      console.log(`${JSON.stringify(view.displayName)} — ${view.subject.draftId} revision ${view.subject.revision}`);
      console.log(`Shared head: ${view.durability.head}`);
      console.log(`Graph: ${view.graph.coverage}; native-host readiness has not been established.`);
      console.log(`Structural lifecycle: ${view.assessment.simulation}. Projected scenarios only; no tests, models or human decisions were executed.`);
      for (const decision of view.missingDecisions) console.log(`${decision.status === 'requires-terminal-review' ? 'Review required' : 'Unresolved'}: ${decision.fieldPath} (${decision.label})`);
      if (view.primaryAction?.effect === 'separate-terminal-review-only') {
        console.log(`Shell: ${view.primaryAction.command}`);
        console.log(`Copilot: ${view.primaryAction.copilotCommand}`);
      }
      console.log('This Show operation requested no proposal, approval, installation, or execution.');
    } else console.log(JSON.stringify(value.data, null, 2));
  }
  return value;
}

/** Scope is resolved by the existing approved configuration owner, never by input JSON. */
export async function run(root, positionals, options, { scope } = {}) {
  const action = validateWorkflowAuthorRequest({ positionals, options });
  if (action === 'where-used') {
    const crossInventory = options['repository-story-refs'] !== undefined;
    const inventory = options['story-refs'] !== undefined || crossInventory;
    const selected = {
      skillId: positionals[3], packageSha256: options['package-sha256'],
      limit: numberOption(options, 'limit', 1, 64, 32), cursor: numberOption(options, 'cursor', 0, inventory ? SKP_STORY_INVENTORY_LIMITS.references : 1024, 0),
      expectedSource: options['expected-source'] };
    const usage = crossInventory
      ? await (await import('../skp-cross-repository-story-inventory.mjs')).lookupCrossRepositoryStorySkillUsageInventory({
        ...selected, repositories: parseCrossRepositoryStoryInventorySubjects(options['repository-story-refs'],
          numberOption(options, 'history-depth', 1, SKP_STORY_INVENTORY_LIMITS.historyDepth, 1)) })
      : inventory
      ? await (await import('../skp-story-usage-inventory.mjs')).lookupLocalStorySkillUsageInventory(root, {
        ...selected, subjects: parseLocalStoryInventorySubjects(options['story-refs'],
          numberOption(options, 'history-depth', 1, SKP_STORY_INVENTORY_LIMITS.historyDepth, 1)) })
      : options.story === undefined
      ? await (await import('../skp-usage.mjs')).lookupApprovedSkillUsage(root, selected)
      : await (await import('../skp-story-usage.mjs')).lookupStorySkillUsage(root, { ...selected,
        workId: options.story, ref: options.ref ?? 'HEAD', commit: options.commit,
        snapshotRevision: numberOption(options, 'snapshot-revision', 1, 64, undefined) });
    return emit({ resultType: 'workflow-author', operation: { id: 'workflow.author.where-used',
      modelPolicy: 'never', classification: 'read' }, status: 'read',
      scope: crossInventory ? { selectedRepositoryStoryInventory: usage.source }
        : inventory ? { selectedStoryInventory: usage.source }
        : options.story === undefined ? { approvedConfiguration: usage.source } : { selectedStory: usage.subject, source: usage.source },
      effects: EFFECTS_NONE, data: { usage } }, Boolean(options.json));
  }
  if (!scope || scope.root !== root || typeof scope.remote !== 'string'
      || typeof scope.workspaceId !== 'string') fail('Select an explicit approved repository draft scope.', 'WCA_DRAFT_SCOPE_UNAVAILABLE');
  const store = openGitDraftStore({ root, remote: scope.remote, workspaceId: scope.workspaceId,
    environmentDeclaration: scope.environmentDeclaration });
  if (options['expected-authority'] !== undefined
      && options['expected-authority'] !== store.capability.repository) {
    fail('The approved draft repository changed. Reload the shared draft before making changes.', 'WCA_DRAFT_AUTHORITY_CHANGED');
  }
  const input = options.input === undefined ? null
    : options.input.startsWith('@approved-starter/')
      ? await readApprovedWorkflowStarterInput(root, scope, options.input)
      : await readWorkflowAuthorInput(path.resolve(options.input));
  const target = positionals[3];
  let data;
  let status = 'read';
  let declaredEffects = EFFECTS_NONE;
  if (action === 'preview' || action === 'catalog' || action === 'submit') {
    const compiler = await import('../wca-compiler.mjs');
    if (action === 'catalog') {
      data = { catalogChoices: compiler.workflowCompilerCatalogChoices(await compiler.captureWorkflowCompilerContext(root), {
        kind: options.kind ?? null, limit: numberOption(options, 'limit', 1, 64, 32), cursor: numberOption(options, 'cursor', 0, 1024, 0) }) };
    } else {
      const revision = numberOption(options, 'revision', 1, 256, null);
      const preview = await compiler.previewWorkflowDraftPackage(root, { draftId: target, revision });
      if (preview.source.repository !== store.capability.repository) fail('The preview authority changed; reload the draft.', 'WCA_DRAFT_AUTHORITY_CHANGED');
      data = { preview };
      if (action === 'submit') {
        const submission = await import('../wca-submission.mjs');
        const review = submission.workflowDraftSubmissionPlan(preview);
        if (!stdin.isTTY || !stdout.isTTY) {
          status = 'needs-human-input'; data = { code: 'WCA_NEEDS_HUMAN_INPUT', preview, review,
            handoff: { kind: 'terminal-review', ...nextRoute(['workflow', 'author', 'submit', target,
              '--revision', String(revision)]) }, nativeConfirmation: 'unavailable' };
        } else {
          console.log(JSON.stringify({ preview, review }, null, 2));
          console.log(preview.skillFinalization?.status === 'requires-exact-terminal-consent'
            ? 'Review the exact producer classifications and skill contracts. Finalizes only an inactive review proposal; imported execution remains unavailable. Cancel is the default.'
            : 'Creates only a review proposal. No approval, activation or execution. Cancel is the default.');
          const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action,
            { label: 'Create review proposal' });
          if (!authorization) { status = 'cancelled'; data = { preview, review }; }
          else {
            data = await submission.createWorkflowDraftReviewProposal(root, { draftId: target, revision,
              expectedPlanSha256: preview.planSha256, confirmation: authorization.token });
            status = data.changed ? 'proposed' : 'unchanged';
            if (data.changed) declaredEffects = { ...EFFECTS_NONE, stateChanged: true, publicationCreated: true, externalSystemsChanged: true };
          }
        }
      }
    }
  } else if (action === 'list') data = await store.list({ limit: numberOption(options, 'limit', 1, 64, 20),
    cursor: numberOption(options, 'cursor', 0, 1024, 0) });
  else if (action === 'history') data = await store.history({ draftId: target,
    limit: numberOption(options, 'limit', 1, 64, 20), cursor: numberOption(options, 'cursor', 0, 1024, 0) });
  else if (action === 'op-status') data = await store.operationStatus({ operationId: target });
  else if (action === 'read' || action === 'show') {
    const selected = await store.readRevision({ draftId: target,
      revision: numberOption(options, 'revision', 1, 256, null) });
    const preview = action === 'show' ? await (await import('../wca-compiler.mjs')).previewWorkflowDraftPackage(root,
      { draftId: target, revision: selected.record.revision }) : null;
    if (preview && (preview.source.repository !== store.capability.repository
      || preview.source.revisionSha256 !== selected.record.revisionSha256)) fail('The Show source changed; reload the draft.', 'WCA_DRAFT_AUTHORITY_CHANGED');
    data = action === 'show' ? { view: showView(selected, scope, preview) } : {
      ...selected, assets: selected.assets.map((asset) => ({ path: asset.path,
        contentBase64: asset.content.toString('base64'), bytes: asset.content.length }))
    };
  } else if (action === 'create' || action === 'save') {
    const expectedHead = options['expected-head'] === 'empty' ? null : options['expected-head'];
    data = action === 'create' ? await store.create({
      draftId: target ?? `WFD-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      displayName: options.name ?? 'Untitled workflow', payload: input?.payload ?? {},
      assets: input?.assets ?? [], expectedHead, operationId: options['operation-id']
    }) : await store.appendRevision({ draftId: target, expectedHead,
      epoch: numberOption(options, 'epoch', 1, 1, 1), operationId: options['operation-id'],
      patch: { ...(input ?? {}), ...(options.name === undefined ? {} : { displayName: options.name }) } });
    status = data.status;
    if (!data.replayed) declaredEffects = { ...EFFECTS_NONE, stateChanged: true, externalSystemsChanged: true };
  } else {
    const selected = await store.readRevision({ draftId: target });
    const review = draftDeletePlan({ remote: store.capability.repository,
      workspaceId: scope.workspaceId, draftId: target,
      expectedHead: selected.head, epoch: selected.record.lifecycleEpoch,
      revisionSha256: selected.record.revisionSha256 });
    const deletion = { effect: 'logical-shared-draft-deletion', draftId: target,
      displayName: selected.record.displayName, revision: selected.record.revision,
      revisionSha256: selected.record.revisionSha256, payloadSha256: selected.record.content.payloadSha256,
      assetManifestSha256: selected.record.content.assetManifestSha256, expectedHead: selected.head,
      lifecycleEpoch: selected.record.lifecycleEpoch, workspaceId: scope.workspaceId,
      remote: store.capability.repository, submittedSnapshots: 'unchanged', activeWorkflows: 'unchanged',
      physicalErasure: 'not-promised', confirmation: { required: true, captured: false, channel: 'terminal',
        assurance: 'configured-local-review', authenticatedNativeHost: false } };
    if (!stdin.isTTY || !stdout.isTTY) {
      status = 'needs-human-input';
      data = { code: 'WCA_NEEDS_HUMAN_INPUT', review: deletion,
        handoff: { kind: 'terminal-review', ...nextRoute(['workflow', 'author', 'delete', target,
          ...(options['operation-id'] ? ['--operation-id', options['operation-id']] : [])]) },
        nativeConfirmation: 'unavailable' };
    } else {
      console.log(JSON.stringify(deletion, null, 2));
      console.log('Submitted snapshots and active workflows will not change. Cancel is the default.');
      const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action,
        { label: 'Delete draft' });
      if (!authorization) { status = 'cancelled'; data = { review: deletion }; }
      else {
        data = await store.delete({ draftId: target, expectedHead: selected.head,
          epoch: selected.record.lifecycleEpoch, operationId: options['operation-id'] ?? randomUUID(),
          confirmation: authorization.token });
        status = data.status;
        if (!data.replayed) declaredEffects = { ...EFFECTS_NONE, stateChanged: true, externalSystemsChanged: true };
      }
    }
  }
  return emit({ resultType: 'workflow-author', operation: { id: `workflow.author.${action}`,
    modelPolicy: 'never', classification: ['create', 'save', 'delete', 'submit'].includes(action) ? 'mutation' : 'read' },
  status, scope: scopeView(scope), capability: store.capability, effects: declaredEffects, data }, Boolean(options.json));
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  assertJiraConnectionPolicy, assertJiraIssuePolicy, assertJiraProjectPolicy,
  findOrCreateIssue, getIssue, getMyPermissions, listEpicStories,
  resolveJiraConnection, updateIssue, uploadJiraAttachment
} from './jira.mjs';
import {
  initiativeBreakdownDocument, loadInitiativeBreakdown, validateInitiativeBreakdown
} from './initiative-repositories.mjs';
import {
  loadInitiative, saveInitiative, secureInitiativePath
} from './initiative-state.mjs';
import {
  SingularityFlowError, nowIso, snapshot, writeJson, writeText
} from './util.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function jiraPath(root, portfolio, initiativeId, relative = '', options = {}) {
  return secureInitiativePath(root, portfolio, initiativeId, path.join('context', 'jira', relative), {
    label: options.label ?? `Initiative '${initiativeId}' Jira path`,
    mustExist: options.mustExist ?? false,
    type: options.type ?? null
  });
}

function onlyRepository(portfolio) {
  const ids = Object.keys(portfolio.repositories);
  return ids.length === 1 ? ids[0] : null;
}

function repositoryFor(issueKey, mapping, portfolio) {
  return mapping?.[issueKey] ?? onlyRepository(portfolio);
}

function importedStoryId(index) {
  return `STORY-${String(index + 1).padStart(3, '0')}`;
}

function issueForRepository(issue, policy) {
  const copy = structuredClone(issue);
  if (policy.read?.attachmentPolicy === 'none') copy.attachments = [];
  else copy.attachments = (copy.attachments ?? []).map(({ url: _url, ...metadata }) => metadata);
  return copy;
}

function governedConnection(policy, { connection, env = process.env } = {}) {
  return assertJiraConnectionPolicy(resolveJiraConnection({ connection, env }), policy);
}

function assertIssueRecordPolicy(issue, policy, label) {
  assertJiraIssuePolicy(issue?.key, policy, label);
  if (issue?.project?.key) assertJiraProjectPolicy(issue.project.key, policy, `${label} project`);
  return issue;
}

function assertReceiptMatches(receipt, { initiativeId, plan, operation, policy }) {
  if (
    receipt?.schemaVersion !== 1
    || receipt.initiativeId !== initiativeId
    || receipt.planSha256 !== plan.sha256
    || receipt.operationId !== operation.id
    || receipt.action !== operation.action
    || hash(receipt.subject) !== hash(operation.subject)
  ) {
    throw new SingularityFlowError(`Jira receipt '${operation.id}' does not match the reviewed write plan.`);
  }
  assertJiraIssuePolicy(receipt.jiraKey, policy, `Jira receipt '${operation.id}'`);
  return receipt;
}

export function assertJiraWriteOperationPolicy(operation, policy = {}) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new SingularityFlowError('Each Jira write-plan operation must be an object.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation.id ?? '')) {
    throw new SingularityFlowError('Each Jira write-plan operation requires a safe ID.');
  }
  if (!(policy.writePolicy?.operations ?? []).includes(operation.action)) {
    throw new SingularityFlowError(`Jira policy does not permit planned operation '${operation.action ?? ''}'.`);
  }
  if (!['create-epic', 'create-story', 'update-owned-fields', 'attach-artifact'].includes(operation.action)) {
    throw new SingularityFlowError(`Jira write-plan action '${operation.action}' is not implemented by this apply path.`);
  }
  if (!operation.subject || typeof operation.subject !== 'object' || !['epic', 'story'].includes(operation.subject.type)) {
    throw new SingularityFlowError(`Jira operation '${operation.id}' requires an Epic or story subject.`);
  }
  if (operation.action === 'attach-artifact') {
    const artifact = operation.artifact;
    if (
      !artifact
      || typeof artifact !== 'object'
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(artifact.reference ?? '')
      || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')
      || !artifact.path
      || !artifact.filename
    ) {
      throw new SingularityFlowError(`Jira operation '${operation.id}' has invalid governed artifact metadata.`);
    }
    return operation;
  }
  if (operation.action.startsWith('create-')) {
    const expectedType = operation.action === 'create-epic' ? 'epic' : 'story';
    if (operation.subject.type !== expectedType || !operation.issue || typeof operation.issue !== 'object' || Array.isArray(operation.issue)) {
      throw new SingularityFlowError(`Jira operation '${operation.id}' does not match its create action.`);
    }
    const unexpected = Object.keys(operation.issue).filter((key) => !['projectKey', 'issueType', 'summary', 'description', 'labels'].includes(key));
    if (unexpected.length) {
      throw new SingularityFlowError(`Jira operation '${operation.id}' contains unsupported create fields: ${unexpected.join(', ')}.`);
    }
    assertJiraProjectPolicy(operation.issue.projectKey, policy, `Jira operation '${operation.id}' project`);
    if (operation.action === 'create-story' && operation.parent?.jiraKey) {
      assertJiraIssuePolicy(operation.parent.jiraKey, policy, `Jira operation '${operation.id}' parent`);
    }
    return operation;
  }
  assertJiraIssuePolicy(operation.subject.jiraKey, policy, `Jira operation '${operation.id}' subject`);
  if (!operation.fields || typeof operation.fields !== 'object' || Array.isArray(operation.fields)) {
    throw new SingularityFlowError(`Jira operation '${operation.id}' requires owned update fields.`);
  }
  const allowed = new Set(policy.writePolicy?.allowedFields ?? []);
  const unsupported = Object.keys(operation.fields).filter((field) => !allowed.has(field));
  if (unsupported.length) {
    throw new SingularityFlowError(`Jira operation '${operation.id}' contains fields outside allowedFields: ${unsupported.join(', ')}.`);
  }
  return operation;
}

function descriptionWithAcceptance(item) {
  return [
    item.description,
    item.acceptanceCriteria?.length ? `Acceptance criteria:\n${item.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

function materializationPhase(initiative) {
  return initiative.phaseOrder.includes('epic-spec')
    ? 'epic-spec'
    : initiative.phaseOrder.includes('epic-plan')
      ? 'epic-plan'
    : initiative.phaseOrder.includes('elaboration')
      ? 'elaboration'
      : initiative.phaseOrder.includes('plan') ? 'plan' : null;
}

function artifactMimeType(kind, file) {
  if (kind === 'yaml' || /\.ya?ml$/i.test(file)) return 'application/yaml';
  if (kind === 'markdown' || /\.md$/i.test(file)) return 'text/markdown';
  return 'application/octet-stream';
}

function artifactFilename(initiativeId, phaseId, output, sha256) {
  const extension = path.extname(output.path);
  const stem = path.basename(output.path, extension)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || output.id;
  const prefix = `${initiativeId}-${phaseId}-${stem}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${prefix.slice(0, 190)}-${sha256.slice(0, 12)}${extension || '.md'}`;
}

async function resolveArtifactSelections(root, portfolio, initiative, selections = []) {
  if (!Array.isArray(selections)) throw new SingularityFlowError('Jira artifact selections must be an array.');
  const seen = new Set();
  const resolved = [];
  for (const selection of selections) {
    const phaseId = String(selection?.phase ?? '');
    const outputId = String(selection?.id ?? '');
    const reference = `${phaseId}/${outputId}`;
    if (seen.has(reference)) throw new SingularityFlowError(`Jira artifact selection '${reference}' is duplicated.`);
    seen.add(reference);
    const phase = initiative.phases?.[phaseId];
    const output = phase?.outputs?.[outputId];
    if (!output) throw new SingularityFlowError(`Jira artifact selection '${reference}' is not an output in this Epic.`);
    if (!output.sha256 || !['published', 'approved'].includes(output.status)) {
      throw new SingularityFlowError(`Jira artifact selection '${reference}' must be published before it can be attached.`);
    }
    const target = await secureInitiativePath(root, portfolio, initiative.initiative.id, output.path, {
      label: `Jira artifact selection '${reference}'`,
      mustExist: true,
      type: 'file'
    });
    const current = await snapshot(target.absolute);
    if (current.sha256 !== output.sha256) {
      throw new SingularityFlowError(`Jira artifact selection '${reference}' changed after publication.`);
    }
    const destinations = [...new Set(selection.targets ?? ['epic'])];
    if (!destinations.length || destinations.some((value) => !['epic', 'stories'].includes(value))) {
      throw new SingularityFlowError(`Jira artifact selection '${reference}' targets must be epic and/or stories.`);
    }
    resolved.push({
      reference,
      phase: phaseId,
      id: outputId,
      label: output.label,
      path: output.path,
      sha256: output.sha256,
      bytes: current.size,
      mimeType: artifactMimeType(output.kind, output.path),
      filename: artifactFilename(initiative.initiative.id, phaseId, output, output.sha256),
      targets: destinations.sort()
    });
  }
  return resolved;
}

export function buildJiraBreakdownDraft(epic, stories, portfolio, {
  repositoryMap = {}
} = {}) {
  const draft = {
    version: 1,
    initiativeId: null,
    source: {
      type: 'jira',
      epicKey: epic.key,
      epicUpdatedAt: epic.updatedAt,
      fetchedAt: nowIso()
    },
    epics: [{
      id: 'EPIC-001',
      jiraKey: epic.key,
      title: epic.title,
      description: epic.description ?? '',
      acceptanceCriteria: epic.acceptanceCriteria ? [epic.acceptanceCriteria] : [],
      stories: stories.map((story, index) => ({
        id: importedStoryId(index),
        jiraKey: story.key,
        title: story.title,
        description: story.description ?? '',
        acceptanceCriteria: story.acceptanceCriteria ? [story.acceptanceCriteria] : [],
        repository: repositoryFor(story.key, repositoryMap, portfolio),
        blocking: true,
        suggestedWorkType: story.issueType?.toLowerCase().includes('bug') ? 'bugfix' : 'feature',
        estimate: story.storyPoints ?? null,
        dependsOn: [],
        consumesContracts: []
      }))
    }]
  };
  const unresolved = draft.epics[0].stories
    .filter((story) => !story.repository || !portfolio.repositories[story.repository])
    .map((story) => ({ storyId: story.id, jiraKey: story.jiraKey, title: story.title }));
  return { draft, unresolved, ready: unresolved.length === 0 };
}

export async function previewJiraAdoption(root, initiativeId, epicKey, {
  repositoryMap = {},
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot. Start a new initiative after enabling Jira.');
  const resolvedConnection = governedConnection(policy, { connection, env });
  const validatedEpicKey = assertJiraIssuePolicy(epicKey, policy, 'Jira Epic');
  const [remoteEpic, remoteStories] = await Promise.all([
    getIssue(validatedEpicKey, { connection: resolvedConnection, fetchImpl }),
    listEpicStories(validatedEpicKey, { connection: resolvedConnection, fetchImpl })
  ]);
  const epic = issueForRepository(assertIssueRecordPolicy(remoteEpic, policy, 'Jira Epic'), policy);
  const stories = remoteStories.map((story) => issueForRepository(
    assertIssueRecordPolicy(story, policy, 'Jira child issue'),
    policy
  ));
  const built = buildJiraBreakdownDraft(epic, stories, portfolio, { repositoryMap });
  built.draft.initiativeId = initiativeId;
  const source = {
    schemaVersion: 1,
    initiativeId,
    epic,
    stories,
    fetchedAt: nowIso()
  };
  return {
    initiativeId,
    phase: materializationPhase(initiative),
    source,
    sourceSha256: hash(source),
    ...built
  };
}

export async function adoptJiraEpic(root, initiativeId, epicKey, options = {}) {
  const preview = await previewJiraAdoption(root, initiativeId, epicKey, options);
  if (!preview.ready) {
    throw new SingularityFlowError(`Repository mapping is required for Jira stories: ${preview.unresolved.map((story) => story.jiraKey).join(', ')}.`);
  }
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdownPath = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  if (breakdownPath.exists) {
    const existing = YAML.parse(await readFile(breakdownPath.absolute, 'utf8'));
    const hasStories = existing?.epics?.some((epic) => epic.stories?.length);
    if (hasStories && options.replace !== true) throw new SingularityFlowError('This initiative already has a story breakdown. Use --replace only after reviewing the Jira import preview.');
  }
  const validated = validateInitiativeBreakdown(preview.draft, portfolio);
  const importPath = await jiraPath(root, portfolio, initiativeId, path.join('imports', `${preview.sourceSha256}.json`), {
    label: `Initiative '${initiativeId}' Jira import`,
    type: 'file'
  });
  const draftPath = await jiraPath(root, portfolio, initiativeId, 'adoption-draft.yml', {
    label: `Initiative '${initiativeId}' Jira adoption draft`,
    type: 'file'
  });
  await writeJson(importPath.absolute, preview.source);
  await writeText(draftPath.absolute, YAML.stringify(preview.draft));
  await writeText(breakdownPath.absolute, YAML.stringify(initiativeBreakdownDocument(validated)));
  initiative.history.push({
    at: nowIso(),
    actor: options.actor ?? null,
    event: 'jira_epic_adopted',
    phase: materializationPhase(initiative),
    detail: `${epicKey}; ${validated.stories.length} stories; source ${preview.sourceSha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { ...preview, portfolio, initiative, breakdown: validated };
}

function allowedUpdateFields(policy, fields) {
  const allowed = new Set(policy.writePolicy?.allowedFields ?? []);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
}

function expectedFields(item, { parentKey = null, initiativeId }) {
  return {
    summary: item.title,
    description: descriptionWithAcceptance(item),
    labels: [`sflow-${initiativeId.toLowerCase()}`, `sflow-${item.id.toLowerCase()}`],
    ...(parentKey ? { parent: { key: parentKey } } : {})
  };
}

function fieldDiff(issue, expected) {
  const diff = {};
  if (expected.summary !== undefined && issue.title !== expected.summary) diff.summary = expected.summary;
  if (expected.description !== undefined && issue.description !== expected.description) diff.description = expected.description;
  if (expected.parent !== undefined && issue.parent?.key !== expected.parent.key) diff.parent = expected.parent;
  if (expected.labels !== undefined) {
    const current = [...(issue.labels ?? [])].sort();
    const desired = [...new Set([...(issue.labels ?? []), ...expected.labels])].sort();
    if (JSON.stringify(current) !== JSON.stringify(desired)) diff.labels = desired;
  }
  return diff;
}

export async function createJiraWritePlan(root, initiativeId, {
  connection,
  artifactSelections = [],
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira ?? portfolio.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot.');
  if (policy.writeMode === 'off') throw new SingularityFlowError('Jira writes are disabled. Set jira.writeMode to preview or approved before starting the initiative.');
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const projectKey = policy.projectKey || portfolio.jira.projectKey;
  if (!projectKey) throw new SingularityFlowError('jira.projectKey is required to create a Jira write plan.');
  const governedProjectKey = assertJiraProjectPolicy(projectKey, policy);
  let resolvedConnection = connection ? governedConnection(policy, { connection, env }) : null;
  const remoteConnection = () => {
    resolvedConnection ??= governedConnection(policy, { connection, env });
    return resolvedConnection;
  };
  const operations = [];
  const snapshots = {};
  const artifacts = await resolveArtifactSelections(root, portfolio, initiative, artifactSelections);
  for (const epic of breakdown.epics) {
    let epicIssue = null;
    if (epic.jiraKey) {
      const epicKey = assertJiraIssuePolicy(epic.jiraKey, policy, `Jira Epic '${epic.id}'`);
      epicIssue = assertIssueRecordPolicy(
        await getIssue(epicKey, { connection: remoteConnection(), fetchImpl }),
        policy,
        `Jira Epic '${epic.id}'`
      );
      snapshots[epic.jiraKey] = epicIssue;
      const fields = allowedUpdateFields(policy, fieldDiff(epicIssue, expectedFields(epic, { initiativeId })));
      if (Object.keys(fields).length) operations.push({
        id: `update-epic-${epic.id}`,
        action: 'update-owned-fields',
        subject: { type: 'epic', id: epic.id, jiraKey: epic.jiraKey },
        expectedUpdatedAt: epicIssue.updatedAt,
        fields
      });
    } else {
      operations.push({
        id: `create-epic-${epic.id}`,
        action: 'create-epic',
        subject: { type: 'epic', id: epic.id, jiraKey: null },
        issue: {
          projectKey: governedProjectKey,
          issueType: policy.epicIssueType ?? 'Epic',
          summary: epic.title,
          description: descriptionWithAcceptance(epic),
          labels: [`sflow-${initiativeId.toLowerCase()}`, `sflow-${epic.id.toLowerCase()}`]
        }
      });
    }
    for (const story of epic.stories) {
      if (story.jiraKey) {
        const storyKey = assertJiraIssuePolicy(story.jiraKey, policy, `Jira story '${story.id}'`);
        const issue = assertIssueRecordPolicy(
          await getIssue(storyKey, { connection: remoteConnection(), fetchImpl }),
          policy,
          `Jira story '${story.id}'`
        );
        snapshots[story.jiraKey] = issue;
        const fields = allowedUpdateFields(policy, fieldDiff(issue, expectedFields(story, { parentKey: epic.jiraKey, initiativeId })));
        if (Object.keys(fields).length) operations.push({
          id: `update-story-${story.id}`,
          action: 'update-owned-fields',
          subject: { type: 'story', id: story.id, epicId: epic.id, jiraKey: story.jiraKey },
          expectedUpdatedAt: issue.updatedAt,
          fields
        });
      } else {
        operations.push({
          id: `create-story-${story.id}`,
          action: 'create-story',
          subject: { type: 'story', id: story.id, epicId: epic.id, jiraKey: null },
          parent: { epicId: epic.id, jiraKey: epic.jiraKey },
          issue: {
            projectKey: governedProjectKey,
            issueType: policy.storyIssueType ?? 'Story',
            summary: story.title,
            description: descriptionWithAcceptance(story),
            labels: [`sflow-${initiativeId.toLowerCase()}`, `sflow-${story.id.toLowerCase()}`]
          }
        });
      }
    }
  }
  const operationId = (artifact, subject) => {
    const readable = `attach-${artifact.phase}-${artifact.id}-${subject.type}-${subject.id}`;
    return readable.length <= 127 ? readable : `${readable.slice(0, 110)}-${hash(readable).slice(0, 12)}`;
  };
  for (const artifact of artifacts) {
    for (const epic of breakdown.epics) {
      if (artifact.targets.includes('epic')) operations.push({
        id: operationId(artifact, { type: 'epic', id: epic.id }),
        action: 'attach-artifact',
        subject: { type: 'epic', id: epic.id, jiraKey: epic.jiraKey ?? null },
        artifact
      });
      if (artifact.targets.includes('stories')) {
        for (const story of epic.stories) operations.push({
          id: operationId(artifact, { type: 'story', id: story.id }),
          action: 'attach-artifact',
          subject: { type: 'story', id: story.id, epicId: epic.id, jiraKey: story.jiraKey ?? null },
          artifact
        });
      }
    }
  }
  const forbidden = operations.filter((operation) => !(policy.writePolicy?.operations ?? []).includes(operation.action));
  if (forbidden.length) throw new SingularityFlowError(`Jira policy does not permit planned operations: ${[...new Set(forbidden.map((operation) => operation.action))].join(', ')}.`);
  const snapshotSha256 = hash(snapshots);
  const planBase = {
    schemaVersion: 1,
    initiativeId,
    projectKey: governedProjectKey,
    connection: policy.connection,
    deployment: policy.deployment,
    source: { breakdownSha256: hash(initiativeBreakdownDocument(breakdown)), jiraSnapshotSha256: snapshotSha256 },
    artifacts,
    operations,
    createdAt: nowIso(),
    status: 'proposed'
  };
  const plan = { ...planBase, sha256: hash(planBase) };
  const snapshotPath = await jiraPath(root, portfolio, initiativeId, path.join('snapshots', `${snapshotSha256}.json`), {
    label: `Initiative '${initiativeId}' Jira snapshot`,
    type: 'file'
  });
  const planPath = await jiraPath(root, portfolio, initiativeId, 'write-plan.yml', {
    label: `Initiative '${initiativeId}' Jira write plan`,
    type: 'file'
  });
  await writeJson(snapshotPath.absolute, snapshots);
  await writeText(planPath.absolute, YAML.stringify(plan));
  initiative.history.push({
    at: plan.createdAt,
    actor: null,
    event: 'jira_write_plan_created',
    phase: materializationPhase(initiative),
    detail: `${operations.length} operations; ${artifacts.length} selected artifacts; ${plan.sha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, plan };
}

export async function readJiraWritePlan(root, portfolio, initiativeId) {
  const file = await jiraPath(root, portfolio, initiativeId, 'write-plan.yml', {
    label: `Initiative '${initiativeId}' Jira write plan`,
    type: 'file'
  });
  if (!file.exists) throw new SingularityFlowError('No Jira write plan exists. Create and review one first.');
  const plan = YAML.parse(await readFile(file.absolute, 'utf8'));
  const provided = plan.sha256;
  const { sha256: _ignored, ...base } = plan;
  if (hash(base) !== provided) throw new SingularityFlowError('The Jira write plan hash is invalid. Regenerate the plan.');
  return plan;
}

export async function applyJiraWritePlan(root, initiativeId, {
  planSha256,
  confirmation,
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch,
  actor = null
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira ?? portfolio.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot.');
  if (policy.writeMode !== 'approved') throw new SingularityFlowError('Jira apply requires the initiative-pinned jira.writeMode to be approved.');
  if (confirmation !== initiativeId) throw new SingularityFlowError(`Jira apply requires exact initiative confirmation '${initiativeId}'.`);
  const plan = await readJiraWritePlan(root, portfolio, initiativeId);
  if (!planSha256 || planSha256 !== plan.sha256) throw new SingularityFlowError(`Jira apply requires exact write-plan hash '${plan.sha256}'.`);
  if (plan.connection !== policy.connection || plan.deployment !== policy.deployment) {
    throw new SingularityFlowError('The Jira write plan does not match the initiative-pinned connection and deployment.');
  }
  const projectKey = assertJiraProjectPolicy(plan.projectKey, policy, 'Jira write-plan project');
  if (!Array.isArray(plan.operations)) throw new SingularityFlowError('The Jira write plan operations are invalid. Regenerate the plan.');
  for (const operation of plan.operations) assertJiraWriteOperationPolicy(operation, policy);
  const resolvedConnection = governedConnection(policy, { connection, env });
  const phaseId = materializationPhase(initiative);
  if (!phaseId || initiative.phases[phaseId]?.status !== 'approved') throw new SingularityFlowError(`Jira apply requires approved initiative phase '${phaseId}'.`);
  const permissions = await getMyPermissions(projectKey, { connection: resolvedConnection, fetchImpl });
  const required = new Set(plan.operations.map((operation) => operation.action === 'attach-artifact'
    ? 'CREATE_ATTACHMENTS'
    : operation.action.startsWith('create-') ? 'CREATE_ISSUES' : 'EDIT_ISSUES'));
  const missing = [...required].filter((name) => !permissions[name]?.havePermission);
  if (missing.length) throw new SingularityFlowError(`Jira account lacks required permissions: ${missing.join(', ')}.`);

  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const results = [];
  const epicKeys = Object.fromEntries(breakdown.epics.filter((epic) => epic.jiraKey).map((epic) => [epic.id, epic.jiraKey]));
  const storyKeys = Object.fromEntries(breakdown.stories.filter((story) => story.jiraKey).map((story) => [story.id, story.jiraKey]));
  for (const operation of plan.operations) {
    const receiptPath = await jiraPath(root, portfolio, initiativeId, path.join('receipts', `${operation.id}.json`), {
      label: `Initiative '${initiativeId}' Jira receipt '${operation.id}'`,
      type: 'file'
    });
    if (receiptPath.exists) {
      const receipt = JSON.parse(await readFile(receiptPath.absolute, 'utf8'));
      assertReceiptMatches(receipt, { initiativeId, plan, operation, policy });
      results.push(receipt);
      if (receipt.subject.type === 'epic') epicKeys[receipt.subject.id] = receipt.jiraKey;
      if (receipt.subject.type === 'story') storyKeys[receipt.subject.id] = receipt.jiraKey;
      continue;
    }
    let result;
    let attachment = null;
    let targetIssue = null;
    if (operation.action === 'attach-artifact') {
      const [artifactPhase, artifactId] = operation.artifact.reference.split('/');
      const governedOutput = initiative.phases?.[artifactPhase]?.outputs?.[artifactId];
      if (
        !governedOutput
        || governedOutput.path !== operation.artifact.path
        || governedOutput.sha256 !== operation.artifact.sha256
        || !['published', 'approved'].includes(governedOutput.status)
      ) {
        throw new SingularityFlowError(`Jira artifact '${operation.artifact.reference}' no longer matches a published governed Epic output.`);
      }
      const jiraKey = operation.subject.jiraKey
        ?? (operation.subject.type === 'epic' ? epicKeys[operation.subject.id] : storyKeys[operation.subject.id]);
      if (!jiraKey) throw new SingularityFlowError(`Cannot attach ${operation.artifact.reference}: ${operation.subject.id} has no Jira key.`);
      targetIssue = assertIssueRecordPolicy(
        await getIssue(jiraKey, { connection: resolvedConnection, fetchImpl }),
        policy,
        `Jira attachment target '${operation.subject.id}'`
      );
      attachment = targetIssue.attachments?.find((item) => item.filename === operation.artifact.filename) ?? null;
      if (!attachment) {
        const selected = await secureInitiativePath(root, portfolio, initiativeId, operation.artifact.path, {
          label: `Jira artifact '${operation.artifact.reference}'`,
          mustExist: true,
          type: 'file'
        });
        const current = await snapshot(selected.absolute);
        if (current.sha256 !== operation.artifact.sha256 || current.size !== operation.artifact.bytes) {
          throw new SingularityFlowError(`Jira artifact '${operation.artifact.reference}' changed after the reviewed write plan was created.`);
        }
        attachment = await uploadJiraAttachment(jiraKey, {
          filename: operation.artifact.filename,
          bytes: await readFile(selected.absolute),
          mimeType: operation.artifact.mimeType
        }, { connection: resolvedConnection, fetchImpl });
      }
      result = targetIssue;
    } else if (operation.action.startsWith('create-')) {
      const parentKey = operation.subject.type === 'story' ? (operation.parent.jiraKey ?? epicKeys[operation.parent.epicId]) : null;
      if (operation.subject.type === 'story' && !parentKey) throw new SingularityFlowError(`Cannot create ${operation.subject.id}: its parent Epic has no Jira key.`);
      result = await findOrCreateIssue({
        ...operation.issue,
        idempotencyLabel: `sflow-${hash({ initiativeId, operationId: operation.id }).slice(0, 24)}`,
        ...(parentKey ? { parentKey } : {})
      }, { connection: resolvedConnection, fetchImpl });
      if (operation.subject.type === 'epic') epicKeys[operation.subject.id] = result.key;
      if (operation.subject.type === 'story') storyKeys[operation.subject.id] = result.key;
    } else {
      result = await updateIssue(operation.subject.jiraKey, operation.fields, {
        expectedUpdatedAt: operation.expectedUpdatedAt,
        connection: resolvedConnection,
        fetchImpl
      });
    }
    assertIssueRecordPolicy(result, policy, `Jira operation '${operation.id}' result`);
    const receipt = {
      schemaVersion: 1,
      initiativeId,
      planSha256: plan.sha256,
      operationId: operation.id,
      action: operation.action,
      subject: operation.subject,
      jiraKey: result.key,
      jiraIssueId: result.id ?? null,
      jiraUpdatedAt: result.updatedAt ?? null,
      appliedAt: nowIso(),
      actor,
      ...(attachment ? {
        attachment: {
          id: attachment.id ?? null,
          filename: attachment.filename,
          sha256: operation.artifact.sha256,
          bytes: attachment.size ?? operation.artifact.bytes,
          mimeType: attachment.mimeType ?? operation.artifact.mimeType,
          reused: Boolean(targetIssue.attachments?.some((item) => item.filename === operation.artifact.filename))
        }
      } : {})
    };
    await writeJson(receiptPath.absolute, receipt);
    results.push(receipt);
  }
  for (const epic of breakdown.epics) {
    const epicReceipt = results.find((receipt) => receipt.subject.type === 'epic' && receipt.subject.id === epic.id);
    epic.jiraKey = epicReceipt?.jiraKey ?? epic.jiraKey;
    epic.jiraIssueId = epicReceipt?.jiraIssueId ?? epic.jiraIssueId;
    for (const story of epic.stories) {
      const storyReceipt = results.find((receipt) => receipt.subject.type === 'story' && receipt.subject.id === story.id);
      story.jiraKey = storyReceipt?.jiraKey ?? story.jiraKey;
      story.jiraIssueId = storyReceipt?.jiraIssueId ?? story.jiraIssueId;
      story.initialJiraKey ??= story.jiraKey ?? null;
      story.jiraAliases = [...new Set([...(story.jiraAliases ?? []), story.jiraKey].filter(Boolean))];
      story.workId = breakdown.version === 2
        ? (story.workId && story.workId !== story.id ? story.workId : (story.jiraKey ?? story.workId ?? story.id))
        : story.id;
      story.epicKey = epic.jiraKey ?? story.epicKey ?? null;
    }
  }
  const breakdownPath = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  await writeText(breakdownPath.absolute, YAML.stringify(initiativeBreakdownDocument(breakdown)));
  const application = {
    schemaVersion: 1,
    initiativeId,
    planSha256: plan.sha256,
    status: 'applied',
    appliedAt: nowIso(),
    appliedBy: actor,
    operations: results.map((receipt) => ({ operationId: receipt.operationId, jiraKey: receipt.jiraKey }))
  };
  const applicationPath = await jiraPath(root, portfolio, initiativeId, path.join('applications', `${plan.sha256}.json`), {
    label: `Initiative '${initiativeId}' Jira application`,
    type: 'file'
  });
  await writeJson(applicationPath.absolute, application);
  initiative.history.push({
    at: application.appliedAt,
    actor,
    event: 'jira_write_plan_applied',
    phase: phaseId,
    detail: `${results.length} operations; ${plan.sha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, plan, application, results };
}

export async function observeJiraDrift(root, initiativeId, {
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const policy = initiative.resolution?.jira ?? portfolio.jira;
  if (!policy?.enabled) throw new SingularityFlowError('Jira was not enabled in this initiative’s immutable configuration snapshot.');
  const resolvedConnection = governedConnection(policy, { connection, env });
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const observations = [];
  for (const epic of breakdown.epics) {
    if (epic.jiraKey) {
      const issue = assertIssueRecordPolicy(await getIssue(epic.jiraKey, { connection: resolvedConnection, fetchImpl }), policy, `Jira Epic '${epic.id}'`);
      const expected = expectedFields(epic, { initiativeId });
      observations.push({
        type: 'epic',
        planId: epic.id,
        jiraIssueId: issue.id,
        initialJiraKey: epic.jiraKey,
        currentJiraKey: issue.key,
        expected,
        observed: { title: issue.title, description: issue.description, labels: issue.labels, parent: issue.parent, updatedAt: issue.updatedAt },
        restoreFields: allowedUpdateFields(policy, fieldDiff(issue, expected))
      });
    }
    for (const story of epic.stories) {
      if (!story.jiraKey) continue;
      const issue = assertIssueRecordPolicy(await getIssue(story.jiraKey, { connection: resolvedConnection, fetchImpl }), policy, `Jira Story '${story.id}'`);
      const expected = expectedFields(story, { parentKey: epic.jiraKey, initiativeId });
      observations.push({
        type: 'story',
        planId: story.id,
        workId: story.workId ?? story.id,
        jiraIssueId: issue.id,
        initialJiraKey: story.jiraKey,
        currentJiraKey: issue.key,
        expected,
        observed: { title: issue.title, description: issue.description, labels: issue.labels, parent: issue.parent, updatedAt: issue.updatedAt },
        restoreFields: allowedUpdateFields(policy, fieldDiff(issue, expected))
      });
    }
  }
  const base = {
    schemaVersion: 1,
    initiativeId,
    source: 'jira',
    observedAt: nowIso(),
    observations: observations.map((entry) => ({ ...entry, drifted: Object.keys(entry.restoreFields).length > 0 }))
  };
  const observationSha256 = hash(base);
  const record = { ...base, observationSha256 };
  const target = await jiraPath(root, portfolio, initiativeId, path.join('drift', `${observationSha256}.json`), {
    label: `Initiative '${initiativeId}' Jira drift observation`,
    type: 'file'
  });
  await writeJson(target.absolute, record);
  initiative.jiraDrift = {
    observationSha256,
    observedAt: base.observedAt,
    drifted: base.observations.filter((entry) => entry.drifted).length,
    path: target.relative
  };
  initiative.history.push({
    at: base.observedAt,
    actor: null,
    event: 'jira_drift_observed',
    phase: initiative.currentPhase,
    detail: `${initiative.jiraDrift.drifted}/${observations.length} issues drifted`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, record };
}

export async function adoptJiraDrift(root, initiativeId, {
  observationSha256,
  actor = null
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const selected = observationSha256 ?? initiative.jiraDrift?.observationSha256;
  if (!selected) throw new SingularityFlowError('No Jira drift observation is available to adopt.');
  const target = await jiraPath(root, portfolio, initiativeId, path.join('drift', `${selected}.json`), {
    label: `Initiative '${initiativeId}' Jira drift observation`,
    mustExist: true,
    type: 'file'
  });
  const record = JSON.parse(await readFile(target.absolute, 'utf8'));
  const { observationSha256: provided, ...base } = record;
  if (provided !== selected || hash(base) !== provided) throw new SingularityFlowError('Jira drift observation hash is invalid.');
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  for (const observation of record.observations.filter((entry) => entry.drifted)) {
    const item = observation.type === 'epic'
      ? breakdown.epics.find((entry) => entry.id === observation.planId)
      : breakdown.stories.find((entry) => entry.id === observation.planId);
    if (!item) continue;
    item.title = observation.observed.title;
    item.description = observation.observed.description;
    item.jiraKey = observation.currentJiraKey;
    item.jiraIssueId = observation.jiraIssueId ?? item.jiraIssueId;
    if (observation.type === 'story') {
      item.workId ??= observation.workId ?? item.id;
      item.jiraAliases = [...new Set([...(item.jiraAliases ?? []), observation.currentJiraKey].filter(Boolean))];
    }
  }
  const breakdownPath = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Initiative '${initiativeId}' breakdown`,
    mustExist: true,
    type: 'file'
  });
  await writeText(breakdownPath.absolute, YAML.stringify(initiativeBreakdownDocument(breakdown)));
  initiative.jiraDrift = { ...initiative.jiraDrift, adoptedAt: nowIso(), adoptedBy: actor, drifted: 0 };
  initiative.history.push({
    at: initiative.jiraDrift.adoptedAt,
    actor,
    event: 'jira_drift_adopted',
    phase: initiative.currentPhase,
    detail: selected.slice(0, 12)
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, breakdown, observation: record };
}
